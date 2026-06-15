package fleetapi

type User struct {
	Login   string `json:"login"`
	Email   string `json:"email"`
	Subject string `json:"subject"`
	Role    string `json:"role"`
}

type State struct {
	User                User      `json:"user"`
	Repos               []string  `json:"repos"`
	InteractiveSessions []Session `json:"interactiveSessions"`
	Cards               []Card    `json:"cards"`
}

type Session struct {
	ID              string               `json:"id"`
	ParentSessionID string               `json:"parentSessionId"`
	RootSessionID   string               `json:"rootSessionId"`
	Repo            string               `json:"repo"`
	Branch          string               `json:"branch"`
	Runtime         string               `json:"runtime"`
	Adapter         string               `json:"adapter"`
	Status          string               `json:"status"`
	Owner           string               `json:"owner"`
	CreatedBy       string               `json:"createdBy"`
	Purpose         string               `json:"purpose"`
	Summary         string               `json:"summary"`
	Capabilities    *SessionCapabilities `json:"capabilities"`
	PtyAvailable    bool                 `json:"ptyAvailable"`
	LeaseID         string               `json:"leaseId"`
	AttachURL       string               `json:"attachUrl"`
	VNCURL          string               `json:"vncUrl"`
	LastEvent       string               `json:"lastEvent"`
	LogArchive      LogArchive           `json:"logArchive"`
}

type SessionCapabilities struct {
	Terminal bool `json:"terminal"`
}

type Card struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Repo      string `json:"repo"`
	Lane      string `json:"lane"`
	LastEvent string `json:"lastEvent"`
}

type CreateSessionRequest struct {
	Repo            string `json:"repo,omitempty"`
	Branch          string `json:"branch,omitempty"`
	Runtime         string `json:"runtime,omitempty"`
	Profile         string `json:"profile,omitempty"`
	Command         string `json:"command,omitempty"`
	Prompt          string `json:"prompt,omitempty"`
	ParentSessionID string `json:"parentSessionId,omitempty"`
	RootSessionID   string `json:"rootSessionId,omitempty"`
	Purpose         string `json:"purpose,omitempty"`
	Summary         string `json:"summary,omitempty"`
}

type CheckpointResult struct {
	Session    Session    `json:"session"`
	Checkpoint Checkpoint `json:"checkpoint"`
}

type CheckpointsResult struct {
	Session     Session      `json:"session"`
	Checkpoints []Checkpoint `json:"checkpoints"`
}

type SessionLogs struct {
	Session Session    `json:"session"`
	Events  []LogEvent `json:"events"`
	Archive LogArchive `json:"archive"`
}

type LogEvent struct {
	Actor     string `json:"actor"`
	Message   string `json:"message"`
	CreatedAt int64  `json:"createdAt"`
}

type LogArchive struct {
	SessionID     string `json:"sessionId"`
	EventCount    int    `json:"eventCount"`
	EventsKey     string `json:"eventsKey"`
	TranscriptKey string `json:"transcriptKey"`
	SummaryKey    string `json:"summaryKey"`
	ArchivedAt    int64  `json:"archivedAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

type Checkpoint struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SessionID string `json:"sessionId"`
	Workdir   string `json:"workdir"`
	CreatedAt int64  `json:"createdAt"`
}

func (s Session) TerminalCapable() bool {
	return s.Capabilities == nil || s.Capabilities.Terminal
}

func (s Session) Attachable() bool {
	if !s.TerminalCapable() || !s.PtyAvailable {
		return false
	}
	switch s.Status {
	case "ready", "attached", "detached":
		return true
	default:
		return false
	}
}

func (s Session) LifecycleStopNote() string {
	if s.Runtime == "github_actions" && s.Status == "stopped" {
		return "GitHub Actions workflow run was not canceled and may continue on GitHub"
	}
	return ""
}

func (s Session) SummaryText() string {
	if s.Summary != "" {
		return s.Summary
	}
	if s.Purpose != "" {
		return s.Purpose
	}
	return s.LastEvent
}
