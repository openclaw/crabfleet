package fleettext

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/openclaw/crabfleet/internal/fleetapi"
)

func Safe(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return -1
		}
		return r
	}, value)
}

func DisplayUser(user fleetapi.User) string {
	if user.Login != "" {
		return "@" + user.Login
	}
	if user.Email != "" {
		return user.Email
	}
	if user.Subject != "" {
		return user.Subject
	}
	return "unknown"
}

func WriteSessionGroups(out io.Writer, sessions []fleetapi.Session, indent string) bool {
	if len(sessions) == 0 {
		return false
	}
	groups := map[string][]fleetapi.Session{}
	owners := make([]string, 0, len(sessions))
	for _, session := range sessions {
		owner := session.Owner
		if owner == "" {
			owner = "unassigned"
		}
		if _, ok := groups[owner]; !ok {
			owners = append(owners, owner)
		}
		groups[owner] = append(groups[owner], session)
	}
	sort.Strings(owners)
	for _, owner := range owners {
		fmt.Fprintf(out, "%s%s:\n", indent, Safe(owner))
		writeSessionTree(out, groups[owner], indent+"  ")
	}
	return true
}

func WriteSessionLogs(out io.Writer, logs fleetapi.SessionLogs) {
	fmt.Fprintf(
		out,
		"session: %s\nrepo: %s\nstatus: %s\n",
		Safe(logs.Session.ID),
		Safe(logs.Session.Repo),
		Safe(logs.Session.Status),
	)
	if logs.Archive.EventCount > 0 {
		fmt.Fprintf(out, "archive: %d events\n", logs.Archive.EventCount)
	}
	for _, event := range logs.Events {
		timestamp := time.UnixMilli(event.CreatedAt).Format("15:04:05")
		fmt.Fprintf(out, "%s %s %s\n", timestamp, Safe(event.Actor), Safe(event.Message))
	}
}

func WriteSessionStatus(out io.Writer, session fleetapi.Session) {
	fmt.Fprintf(out, "session: %s\n", Safe(session.ID))
	fmt.Fprintf(out, "repo: %s\n", Safe(session.Repo))
	fmt.Fprintf(out, "branch: %s\n", Safe(session.Branch))
	fmt.Fprintf(out, "runtime: %s\n", Safe(session.Runtime))
	fmt.Fprintf(out, "status: %s\n", Safe(session.Status))
	fmt.Fprintf(out, "owner: %s\n", Safe(session.Owner))
	if session.LeaseID != "" {
		fmt.Fprintf(out, "lease: %s\n", Safe(session.LeaseID))
	}
	if session.ParentSessionID != "" {
		fmt.Fprintf(out, "parent: %s\n", Safe(session.ParentSessionID))
	}
	if session.RootSessionID != "" {
		fmt.Fprintf(out, "root: %s\n", Safe(session.RootSessionID))
	}
	if session.CreatedBy != "" {
		fmt.Fprintf(out, "created-by: %s\n", Safe(session.CreatedBy))
	}
	if session.Purpose != "" {
		fmt.Fprintf(out, "purpose: %s\n", Safe(session.Purpose))
	}
	if session.Summary != "" {
		fmt.Fprintf(out, "summary: %s\n", Safe(session.Summary))
	}
	if session.AttachURL != "" {
		fmt.Fprintf(out, "attach: %s\n", Safe(session.AttachURL))
	}
	if session.VNCURL != "" {
		fmt.Fprintf(out, "vnc: %s\n", Safe(session.VNCURL))
	}
	if session.LastEvent != "" {
		fmt.Fprintf(out, "event: %s\n", Safe(session.LastEvent))
	}
}

func WriteSessionSummary(out io.Writer, session fleetapi.Session) {
	fmt.Fprintf(out, "session: %s\n", Safe(session.ID))
	if session.Purpose != "" {
		fmt.Fprintf(out, "purpose: %s\n", Safe(session.Purpose))
	}
	if session.Summary != "" {
		fmt.Fprintf(out, "summary: %s\n", Safe(session.Summary))
	}
}

func CompactList(values []string, limit int) string {
	if len(values) == 0 {
		return "none"
	}
	if len(values) > limit {
		return fmt.Sprintf("%s, +%d more", strings.Join(safeSlice(values[:limit]), ", "), len(values)-limit)
	}
	return strings.Join(safeSlice(values), ", ")
}

func writeSessionTree(out io.Writer, sessions []fleetapi.Session, indent string) {
	byParent := map[string][]fleetapi.Session{}
	known := map[string]bool{}
	seen := map[string]bool{}
	for _, session := range sessions {
		known[session.ID] = true
		byParent[session.ParentSessionID] = append(byParent[session.ParentSessionID], session)
	}
	for parent := range byParent {
		sortSessions(byParent[parent])
	}
	roots := make([]fleetapi.Session, 0, len(sessions))
	for _, session := range sessions {
		if session.ParentSessionID == "" || !known[session.ParentSessionID] {
			roots = append(roots, session)
		}
	}
	sortSessions(roots)
	var walk func(fleetapi.Session, string)
	walk = func(session fleetapi.Session, prefix string) {
		if seen[session.ID] {
			return
		}
		seen[session.ID] = true
		fmt.Fprintf(out, "%s%s\n", prefix, sessionLine(session))
		for _, child := range byParent[session.ID] {
			walk(child, prefix+"  ")
		}
	}
	for _, root := range roots {
		walk(root, indent)
	}
	for _, session := range sessions {
		if !seen[session.ID] {
			walk(session, indent)
		}
	}
}

func sessionLine(session fleetapi.Session) string {
	parts := []string{
		Safe(session.ID),
		Safe(session.Status),
		Safe(session.Runtime),
		Safe(session.Repo),
	}
	if summary := session.SummaryText(); summary != "" {
		parts = append(parts, "- "+Safe(summary))
	}
	return strings.Join(parts, "  ")
}

func sortSessions(sessions []fleetapi.Session) {
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessions[i].ID < sessions[j].ID
	})
}

func safeSlice(values []string) []string {
	safe := make([]string, len(values))
	for i, value := range values {
		safe[i] = Safe(value)
	}
	return safe
}
