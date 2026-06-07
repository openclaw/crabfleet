package main

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

func TestSplitCommandKeepsQuotedValues(t *testing.T) {
	args, err := splitCommand(`new --repo openclaw/crabfleet --command 'codex --yolo' 'fix the failing check'`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"new",
		"--repo",
		"openclaw/crabfleet",
		"--command",
		"codex --yolo",
		"fix the failing check",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestSplitCommandPreservesBackslashesInSingleQuotes(t *testing.T) {
	args, err := splitCommand(`new 'fix regex \d+ in parser'`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"new", `fix regex \d+ in parser`}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestParseCreateKeepsLineageAndSummaryFlags(t *testing.T) {
	create := parseCreate(
		[]string{
			"--repo", "openclaw/crabfleet",
			"--parent", "IS-1",
			"--root", "IS-root",
			"--purpose", "inspect sibling",
			"--summary", "summary text",
			"continue work",
		},
		nil,
		"",
	)
	if got, want := create.request.ParentSessionID, "IS-1"; got != want {
		t.Fatalf("parent = %q, want %q", got, want)
	}
	if got, want := create.request.RootSessionID, "IS-root"; got != want {
		t.Fatalf("root = %q, want %q", got, want)
	}
	if got, want := create.request.Purpose, "inspect sibling"; got != want {
		t.Fatalf("purpose = %q, want %q", got, want)
	}
	if got, want := create.request.Summary, "summary text"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
	if got, want := create.request.Prompt, "continue work"; got != want {
		t.Fatalf("prompt = %q, want %q", got, want)
	}
}

func TestParseMessageKeepsNoEnterAndText(t *testing.T) {
	message := parseMessage([]string{"--no-enter", "hello", "child"})
	if !message.noEnter {
		t.Fatal("expected no-enter")
	}
	if got, want := message.text, "hello child"; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}
}

func TestPrintListShowsOwnersAndSessionTree(t *testing.T) {
	var out bytes.Buffer
	printList(&out, stateResponse{
		User:  user{Login: "steipete", Role: "owner"},
		Repos: []string{"openclaw/crabfleet"},
		InteractiveSessions: []interactiveSession{
			{
				ID:              "IS-2",
				Owner:           "steipete",
				Repo:            "openclaw/crabfleet",
				Runtime:         "container",
				Status:          "ready",
				Summary:         "child mission",
				ParentSessionID: "IS-1",
			},
			{
				ID:      "IS-1",
				Owner:   "steipete",
				Repo:    "openclaw/crabfleet",
				Runtime: "container",
				Status:  "ready",
				Purpose: "root mission",
			},
		},
	})

	text := out.String()
	for _, want := range []string{
		"sessions:",
		"  steipete:",
		"    IS-1  ready  container  openclaw/crabfleet  - root mission",
		"      IS-2  ready  container  openclaw/crabfleet  - child mission",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}
