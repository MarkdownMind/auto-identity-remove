package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var webAssets embed.FS

var brokerNamePattern = regexp.MustCompile(`name:\s*'((?:\\'|[^'])+)'`)

type appServer struct {
	repoRoot    string
	configPath  string
	statePath   string
	brokersPath string
	logsDir     string

	mu          sync.Mutex
	cmd         *exec.Cmd
	startedAt   time.Time
	logBuffer   []logEvent
	subscribers map[chan logEvent]struct{}
}

type logEvent struct {
	Time   string `json:"time"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

type configResponse struct {
	Person   personSection   `json:"person"`
	Settings settingsSection `json:"settings"`
	Raw      map[string]any  `json:"raw,omitempty"`
}

type configPayload struct {
	Person   personSection   `json:"person"`
	Settings settingsSection `json:"settings"`
}

type personSection struct {
	FirstName string   `json:"firstName"`
	LastName  string   `json:"lastName"`
	City      string   `json:"city"`
	State     string   `json:"state"`
	Zip       string   `json:"zip"`
	Email     string   `json:"email"`
	Phone     string   `json:"phone"`
	Aliases   []string `json:"aliases"`
}

type settingsSection struct {
	BrowserEngine       string `json:"browserEngine"`
	Headed              bool   `json:"headed"`
	ProxyServer         string `json:"proxyServer"`
	ProxyUsername       string `json:"proxyUsername"`
	ProxyPassword       string `json:"proxyPassword"`
	CapsolverAPIKey     string `json:"capsolverApiKey"`
	NotificationWebhook string `json:"notificationWebhook"`
	NotificationSMS     string `json:"notificationSms"`
	ProfileDir          string `json:"profileDir"`
}

type runStatusResponse struct {
	Status    string `json:"status"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
}

type stateResponse struct {
	State     map[string]any    `json:"state"`
	Dashboard []dashboardBroker `json:"dashboard"`
	History   []historyEntry    `json:"history"`
}

type dashboardBroker struct {
	Broker            string `json:"broker"`
	Status            string `json:"status"`
	RawStatus         string `json:"rawStatus"`
	Detail            string `json:"detail,omitempty"`
	LastSuccess       string `json:"lastSuccess,omitempty"`
	LastAttempt       string `json:"lastAttempt,omitempty"`
	ConsecutiveErrors int    `json:"consecutiveErrors"`
}

type historyEntry struct {
	Broker            string   `json:"broker"`
	LastResult        string   `json:"lastResult"`
	LastSuccess       string   `json:"lastSuccess,omitempty"`
	LastAttempt       string   `json:"lastAttempt,omitempty"`
	ConsecutiveErrors int      `json:"consecutiveErrors"`
	PendingConfirm    bool     `json:"pendingConfirm"`
	Detail            string   `json:"detail,omitempty"`
	History           []string `json:"history,omitempty"`
}

type runLogFile struct {
	Succeeded      []logBucketEntry `json:"succeeded"`
	Skipped        []logBucketEntry `json:"skipped"`
	NotFound       []logBucketEntry `json:"notFound"`
	CaptchaFailed  []logBucketEntry `json:"captchaFailed"`
	Manual         []logBucketEntry `json:"manual"`
	Errors         []logBucketEntry `json:"errors"`
	Dead           []logBucketEntry `json:"dead"`
	PendingConfirm []logBucketEntry `json:"pendingConfirm"`
}

type logBucketEntry struct {
	Broker string `json:"broker"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Time   string `json:"time"`
}

type screenshotEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	URL     string `json:"url"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
	Source  string `json:"source"`
}

func main() {
	repoRoot := discoverRepoRoot()
	server := &appServer{
		repoRoot:    repoRoot,
		configPath:  filepath.Join(repoRoot, "config.json"),
		statePath:   filepath.Join(repoRoot, "state.json"),
		brokersPath: filepath.Join(repoRoot, "brokers.js"),
		logsDir:     filepath.Join(repoRoot, "logs"),
		subscribers: make(map[chan logEvent]struct{}),
	}

	mux := http.NewServeMux()
	server.registerRoutes(mux)

	listener, port, err := listenLocalPort()
	if err != nil {
		log.Fatalf("listen failed: %v", err)
	}
	defer listener.Close()

	httpServer := &http.Server{Handler: mux}
	url := fmt.Sprintf("http://localhost:%d", port)
	log.Printf("auto-identity-remove GUI at %s (repo root: %s)", url, repoRoot)
	go openBrowser(url)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		_ = server.stopWatcher()
	}()

	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func (s *appServer) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/run/start", s.handleRunStart)
	mux.HandleFunc("/api/run/stop", s.handleRunStop)
	mux.HandleFunc("/api/run/status", s.handleRunStatus)
	mux.HandleFunc("/api/logs/stream", s.handleLogStream)
	mux.HandleFunc("/api/screenshots", s.handleScreenshots)
	mux.HandleFunc("/api/screenshots/file", s.handleScreenshotFile)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
	})

	sub, err := fs.Sub(webAssets, "web")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			index, err := fs.ReadFile(sub, "index.html")
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(index)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func (s *appServer) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, err := s.loadConfigMap()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, normalizeConfig(cfg))
	case http.MethodPost:
		var payload configPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		cfg, err := s.loadConfigMap()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		applyConfigPayload(cfg, payload)
		if err := writeJSONFile(s.configPath, cfg); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, normalizeConfig(cfg))
	default:
		writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func (s *appServer) handleState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	state, err := s.loadStateMap()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	brokers := s.loadBrokerNames()
	latestLog := s.loadLatestRunStatuses()
	resp := stateResponse{
		State:     state,
		Dashboard: buildDashboard(state, brokers, latestLog),
		History:   buildHistory(state),
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *appServer) handleRunStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	status, err := s.startWatcher()
	if err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *appServer) handleRunStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	if err := s.stopWatcher(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, s.currentStatus())
}

func (s *appServer) handleRunStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, s.currentStatus())
}

func (s *appServer) handleLogStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, snapshot := s.subscribe()
	defer s.unsubscribe(ch)

	for _, entry := range snapshot {
		if err := writeSSE(w, entry); err != nil {
			return
		}
	}
	flusher.Flush()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			if err := writeSSE(w, ev); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *appServer) handleScreenshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	files, err := s.listScreenshots()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (s *appServer) handleScreenshotFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	rawPath := r.URL.Query().Get("path")
	if rawPath == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	cleanPath, err := filepath.Abs(rawPath)
	if err != nil || !s.isAllowedScreenshotPath(cleanPath) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	http.ServeFile(w, r, cleanPath)
}

func (s *appServer) subscribe() (chan logEvent, []logEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan logEvent, 128)
	s.subscribers[ch] = struct{}{}
	snapshot := append([]logEvent(nil), s.logBuffer...)
	return ch, snapshot
}

func (s *appServer) unsubscribe(ch chan logEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subscribers, ch)
	close(ch)
}

func (s *appServer) addLog(stream, line string) {
	cleaned := strings.TrimRight(line, "\r\n")
	if cleaned == "" {
		return
	}
	event := logEvent{
		Time:   time.Now().Format(time.RFC3339),
		Stream: stream,
		Line:   cleaned,
	}

	s.mu.Lock()
	s.logBuffer = append(s.logBuffer, event)
	if len(s.logBuffer) > 2000 {
		s.logBuffer = append([]logEvent(nil), s.logBuffer[len(s.logBuffer)-2000:]...)
	}
	for ch := range s.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
	s.mu.Unlock()
}

func (s *appServer) startWatcher() (runStatusResponse, error) {
	s.mu.Lock()
	if s.cmd != nil && s.cmd.Process != nil {
		defer s.mu.Unlock()
		return runStatusResponse{}, errors.New("watcher.js is already running")
	}
	cmd := exec.Command("node", "watcher.js")
	cmd.Dir = s.repoRoot
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.mu.Unlock()
		return runStatusResponse{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.mu.Unlock()
		return runStatusResponse{}, err
	}
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return runStatusResponse{}, err
	}
	s.cmd = cmd
	s.startedAt = time.Now()
	pid := cmd.Process.Pid
	s.mu.Unlock()

	s.addLog("system", fmt.Sprintf("Started node watcher.js (pid %d)", pid))
	go s.scanPipe(stdout, "stdout")
	go s.scanPipe(stderr, "stderr")
	go s.waitForWatcher(cmd)
	return s.currentStatus(), nil
}

func (s *appServer) waitForWatcher(cmd *exec.Cmd) {
	err := cmd.Wait()
	statusLine := "watcher.js exited cleanly"
	if err != nil {
		statusLine = fmt.Sprintf("watcher.js exited: %v", err)
	}
	s.addLog("system", statusLine)

	s.mu.Lock()
	if s.cmd == cmd {
		s.cmd = nil
	}
	s.mu.Unlock()
}

func (s *appServer) scanPipe(pipe io.ReadCloser, stream string) {
	defer pipe.Close()
	scanner := bufio.NewScanner(pipe)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		s.addLog(stream, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		s.addLog("system", fmt.Sprintf("%s stream error: %v", stream, err))
	}
}

func (s *appServer) stopWatcher() error {
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return errors.New("watcher.js is not running")
	}
	s.addLog("system", fmt.Sprintf("Stopping watcher.js (pid %d)", cmd.Process.Pid))
	if err := cmd.Process.Signal(syscall.Signal(15)); err != nil {
		return cmd.Process.Kill()
	}
	go func(proc *os.Process) {
		time.Sleep(10 * time.Second)
		s.mu.Lock()
		stillRunning := s.cmd != nil && s.cmd.Process != nil && s.cmd.Process.Pid == proc.Pid
		s.mu.Unlock()
		if stillRunning {
			s.addLog("system", fmt.Sprintf("Force killing watcher.js (pid %d) after timeout", proc.Pid))
			_ = proc.Kill()
		}
	}(cmd.Process)
	return nil
}

func (s *appServer) currentStatus() runStatusResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return runStatusResponse{Status: "stopped", Running: false}
	}
	return runStatusResponse{
		Status:    "running",
		Running:   true,
		PID:       s.cmd.Process.Pid,
		StartedAt: s.startedAt.Format(time.RFC3339),
	}
}

func (s *appServer) loadConfigMap() (map[string]any, error) {
	return loadJSONMap(s.configPath)
}

func (s *appServer) loadStateMap() (map[string]any, error) {
	return loadJSONMap(s.statePath)
}

func normalizeConfig(cfg map[string]any) configResponse {
	personMap := getMap(cfg, "person")
	settings := settingsSection{
		BrowserEngine:       getString(getMap(cfg, "browser"), "engine"),
		Headed:              getBool(getMap(cfg, "browser"), "headed"),
		ProxyServer:         getString(getMap(getMap(cfg, "browser"), "proxy"), "server"),
		ProxyUsername:       getString(getMap(getMap(cfg, "browser"), "proxy"), "username"),
		ProxyPassword:       getString(getMap(getMap(cfg, "browser"), "proxy"), "password"),
		CapsolverAPIKey:     getString(getMap(cfg, "capsolver"), "apiKey"),
		NotificationWebhook: getString(getMap(cfg, "notify"), "webhook"),
		NotificationSMS:     getString(getMap(cfg, "notify"), "textTo"),
		ProfileDir:          getString(cfg, "profileDir"),
	}
	if settings.BrowserEngine == "" {
		settings.BrowserEngine = "camofox"
	}
	return configResponse{
		Person: personSection{
			FirstName: getString(personMap, "firstName"),
			LastName:  getString(personMap, "lastName"),
			City:      getString(personMap, "city"),
			State:     getString(personMap, "state"),
			Zip:       getString(personMap, "zip"),
			Email:     getString(personMap, "email"),
			Phone:     getString(personMap, "phone"),
			Aliases:   getStringSlice(personMap, "aliases"),
		},
		Settings: settings,
		Raw:      cfg,
	}
}

func applyConfigPayload(cfg map[string]any, payload configPayload) {
	person := ensureMap(cfg, "person")
	country := getString(person, "country")
	if country == "" {
		country = "US"
	}
	person["firstName"] = strings.TrimSpace(payload.Person.FirstName)
	person["lastName"] = strings.TrimSpace(payload.Person.LastName)
	person["fullName"] = strings.TrimSpace(strings.TrimSpace(payload.Person.FirstName) + " " + strings.TrimSpace(payload.Person.LastName))
	person["aliases"] = sanitizeAliases(payload.Person.Aliases)
	person["city"] = strings.TrimSpace(payload.Person.City)
	person["state"] = strings.TrimSpace(payload.Person.State)
	person["zip"] = strings.TrimSpace(payload.Person.Zip)
	person["email"] = strings.TrimSpace(payload.Person.Email)
	person["phone"] = strings.TrimSpace(payload.Person.Phone)
	person["country"] = country
	person["phoneFormatted"] = formatPhone(strings.TrimSpace(payload.Person.Phone), country)

	capsolver := ensureMap(cfg, "capsolver")
	capsolver["apiKey"] = strings.TrimSpace(payload.Settings.CapsolverAPIKey)

	notify := ensureMap(cfg, "notify")
	notify["textTo"] = strings.TrimSpace(payload.Settings.NotificationSMS)
	webhook := strings.TrimSpace(payload.Settings.NotificationWebhook)
	if webhook == "" {
		delete(notify, "webhook")
	} else {
		notify["webhook"] = webhook
	}

	cfg["profileDir"] = strings.TrimSpace(payload.Settings.ProfileDir)

	browser := ensureMap(cfg, "browser")
	browser["engine"] = strings.TrimSpace(payload.Settings.BrowserEngine)
	browser["headed"] = payload.Settings.Headed
	proxyServer := strings.TrimSpace(payload.Settings.ProxyServer)
	proxyUser := strings.TrimSpace(payload.Settings.ProxyUsername)
	proxyPass := strings.TrimSpace(payload.Settings.ProxyPassword)
	if proxyServer == "" && proxyUser == "" && proxyPass == "" {
		delete(browser, "proxy")
	} else {
		proxy := ensureMap(browser, "proxy")
		proxy["server"] = proxyServer
		proxy["username"] = proxyUser
		proxy["password"] = proxyPass
	}
}

func buildHistory(state map[string]any) []historyEntry {
	optOuts := getMap(state, "optOuts")
	entries := make([]historyEntry, 0, len(optOuts))
	for broker, raw := range optOuts {
		entryMap, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		history := getStringSlice(entryMap, "history")
		entries = append(entries, historyEntry{
			Broker:            broker,
			LastResult:        lastHistoryStatus(entryMap),
			LastSuccess:       getString(entryMap, "lastSuccess"),
			LastAttempt:       getString(entryMap, "lastAttempt"),
			ConsecutiveErrors: consecutiveErrors(history),
			PendingConfirm:    getMap(entryMap, "pendingConfirm") != nil,
			Detail:            firstNonEmpty(getString(entryMap, "lastDetail"), getString(entryMap, "detail")),
			History:           history,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		left := firstNonEmpty(entries[i].LastAttempt, entries[i].LastSuccess)
		right := firstNonEmpty(entries[j].LastAttempt, entries[j].LastSuccess)
		if left == right {
			return strings.ToLower(entries[i].Broker) < strings.ToLower(entries[j].Broker)
		}
		return left > right
	})
	return entries
}

func buildDashboard(state map[string]any, brokers []string, latestLog map[string]logBucketEntry) []dashboardBroker {
	optOuts := getMap(state, "optOuts")
	all := make(map[string]struct{})
	for _, broker := range brokers {
		all[broker] = struct{}{}
	}
	for broker := range optOuts {
		all[broker] = struct{}{}
	}
	for broker := range latestLog {
		all[broker] = struct{}{}
	}

	entries := make([]dashboardBroker, 0, len(all))
	for broker := range all {
		entryMap, _ := optOuts[broker].(map[string]any)
		history := getStringSlice(entryMap, "history")
		item := dashboardBroker{
			Broker:            broker,
			Status:            "pending",
			RawStatus:         lastHistoryStatus(entryMap),
			Detail:            firstNonEmpty(getString(entryMap, "lastDetail"), getString(entryMap, "detail")),
			LastSuccess:       getString(entryMap, "lastSuccess"),
			LastAttempt:       getString(entryMap, "lastAttempt"),
			ConsecutiveErrors: consecutiveErrors(history),
		}
		if latest, ok := latestLog[broker]; ok {
			item.RawStatus = latest.Status
			item.Status = dashboardStatusFromRaw(latest.Status)
			item.Detail = latest.Detail
		} else {
			item.Status = dashboardStatusFromState(entryMap)
		}
		entries = append(entries, item)
	}

	sort.Slice(entries, func(i, j int) bool {
		left := statusRank(entries[i].Status)
		right := statusRank(entries[j].Status)
		if left == right {
			return strings.ToLower(entries[i].Broker) < strings.ToLower(entries[j].Broker)
		}
		return left < right
	})
	return entries
}

func statusRank(status string) int {
	switch status {
	case "error":
		return 0
	case "pending":
		return 1
	case "manual":
		return 2
	case "success":
		return 3
	case "skipped":
		return 4
	default:
		return 5
	}
}

func dashboardStatusFromRaw(status string) string {
	switch status {
	case "success":
		return "success"
	case "skipped", "notFound", "preview":
		return "skipped"
	case "manual", "captcha_failed":
		return "manual"
	case "pending_confirm":
		return "pending"
	case "error", "dead", "unverified":
		return "error"
	default:
		return "pending"
	}
}

func dashboardStatusFromState(entry map[string]any) string {
	if entry == nil {
		return "pending"
	}
	if getMap(entry, "pendingConfirm") != nil {
		return "pending"
	}
	history := getStringSlice(entry, "history")
	if len(history) == 0 {
		if getString(entry, "lastSuccess") != "" {
			return "success"
		}
		return "pending"
	}
	return dashboardStatusFromRaw(history[len(history)-1])
}

func (s *appServer) loadBrokerNames() []string {
	data, err := os.ReadFile(s.brokersPath)
	if err != nil {
		return nil
	}
	matches := brokerNamePattern.FindAllSubmatch(data, -1)
	seen := make(map[string]struct{})
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		name := strings.ReplaceAll(string(match[1]), `\\'`, `'`)
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (s *appServer) loadLatestRunStatuses() map[string]logBucketEntry {
	files, err := filepath.Glob(filepath.Join(s.logsDir, "run-*.json"))
	if err != nil || len(files) == 0 {
		return nil
	}
	sort.Strings(files)
	data, err := os.ReadFile(files[len(files)-1])
	if err != nil {
		return nil
	}
	var logFile runLogFile
	if err := json.Unmarshal(data, &logFile); err != nil {
		return nil
	}
	statusByBroker := make(map[string]logBucketEntry)
	appendBucket := func(items []logBucketEntry) {
		for _, item := range items {
			statusByBroker[item.Broker] = item
		}
	}
	appendBucket(logFile.Succeeded)
	appendBucket(logFile.Skipped)
	appendBucket(logFile.NotFound)
	appendBucket(logFile.CaptchaFailed)
	appendBucket(logFile.Manual)
	appendBucket(logFile.Errors)
	appendBucket(logFile.Dead)
	appendBucket(logFile.PendingConfirm)
	return statusByBroker
}

func (s *appServer) listScreenshots() ([]screenshotEntry, error) {
	cfg, _ := s.loadConfigMap()
	browserCfg := getMap(cfg, "browser")
	candidateDirs := []string{
		filepath.Join(s.repoRoot, "logs", "snapshots"),
		expandHome(getString(browserCfg, "tracingDir")),
		filepath.Join(userHomeDir(), ".camofox", "traces"),
	}
	seen := make(map[string]struct{})
	files := make([]screenshotEntry, 0)
	for _, dir := range candidateDirs {
		if dir == "" {
			continue
		}
		absDir, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		if _, ok := seen[absDir]; ok {
			continue
		}
		seen[absDir] = struct{}{}
		if err := filepath.WalkDir(absDir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d == nil || d.IsDir() {
				return nil
			}
			if strings.ToLower(filepath.Ext(d.Name())) != ".png" {
				return nil
			}
			info, statErr := d.Info()
			if statErr != nil {
				return nil
			}
			files = append(files, screenshotEntry{
				Name:    d.Name(),
				Path:    path,
				URL:     "/api/screenshots/file?path=" + urlQueryEscape(path),
				Size:    info.Size(),
				ModTime: info.ModTime().Format(time.RFC3339),
				Source:  absDir,
			})
			return nil
		}); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ModTime > files[j].ModTime })
	return files, nil
}

func (s *appServer) isAllowedScreenshotPath(path string) bool {
	files, err := s.listScreenshots()
	if err != nil {
		return false
	}
	for _, file := range files {
		if file.Path == path {
			return true
		}
	}
	return false
}

func loadJSONMap(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func writeJSONFile(path string, data map[string]any) error {
	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o600)
}

func getMap(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	child, _ := m[key].(map[string]any)
	return child
}

func ensureMap(m map[string]any, key string) map[string]any {
	if child := getMap(m, key); child != nil {
		return child
	}
	child := map[string]any{}
	m[key] = child
	return child
}

func getString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	value, ok := m[key]
	if !ok || value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	default:
		return fmt.Sprint(v)
	}
}

func getBool(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	value, ok := m[key]
	if !ok || value == nil {
		return false
	}
	b, _ := value.(bool)
	return b
}

func getStringSlice(m map[string]any, key string) []string {
	if m == nil {
		return nil
	}
	raw, ok := m[key]
	if !ok || raw == nil {
		return nil
	}
	items, ok := raw.([]any)
	if !ok {
		if stringsValue, ok := raw.([]string); ok {
			return append([]string(nil), stringsValue...)
		}
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func sanitizeAliases(values []string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func lastHistoryStatus(entry map[string]any) string {
	history := getStringSlice(entry, "history")
	if len(history) == 0 {
		if getMap(entry, "pendingConfirm") != nil {
			return "pending_confirm"
		}
		if getString(entry, "lastSuccess") != "" {
			return "success"
		}
		return "pending"
	}
	return history[len(history)-1]
}

func consecutiveErrors(history []string) int {
	count := 0
	for i := len(history) - 1; i >= 0; i-- {
		switch history[i] {
		case "error", "captcha_failed", "dead", "unverified":
			count++
		default:
			return count
		}
	}
	return count
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeMethodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func writeSSE(w http.ResponseWriter, ev logEvent) error {
	payload, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", payload)
	return err
}

func listenLocalPort() (net.Listener, int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:8080")
	if err == nil {
		return listener, 8080, nil
	}
	listener, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, 0, err
	}
	addr := listener.Addr().(*net.TCPAddr)
	return listener, addr.Port, nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func discoverRepoRoot() string {
	candidates := []string{}
	appendCandidate := func(path string) {
		if path == "" {
			return
		}
		for _, existing := range candidates {
			if existing == path {
				return
			}
		}
		candidates = append(candidates, path)
	}
	cwd, _ := os.Getwd()
	exe, _ := os.Executable()
	exeDir := filepath.Dir(exe)
	appendCandidate(cwd)
	appendCandidate(filepath.Dir(cwd))
	appendCandidate(exeDir)
	appendCandidate(filepath.Dir(exeDir))
	for _, candidate := range candidates {
		if hasProjectFiles(candidate) {
			return candidate
		}
	}
	return cwd
}

func hasProjectFiles(dir string) bool {
	for _, name := range []string{"watcher.js", "config.json", "state.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			return false
		}
	}
	return true
}

func expandHome(path string) string {
	if path == "" || !strings.HasPrefix(path, "~") {
		return path
	}
	home := userHomeDir()
	if path == "~" {
		return home
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~/"))
}

func formatPhone(phone, country string) string {
	if country == "US" && len(phone) == 10 {
		return fmt.Sprintf("(%s) %s-%s", phone[:3], phone[3:6], phone[6:])
	}
	return phone
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func userHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func urlQueryEscape(value string) string {
	return url.QueryEscape(value)
}
