// Conversation Memory — Go
// JSON-backed session store. No gob/encoding, no pickle — pure JSON so
// loading a session file cannot execute code under any circumstances.

package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var safeIDRe = regexp.MustCompile(`^[a-zA-Z0-9\-]+$`)

type Session struct {
	SessionID  string                   `json:"session_id"`
	CreatedAt  float64                  `json:"created_at"`
	UpdatedAt  float64                  `json:"updated_at"`
	Messages   []map[string]interface{} `json:"messages"`
	Summary    string                   `json:"summary"`
	Metadata   map[string]string        `json:"metadata"`
}

type MemoryStore struct {
	dir string
	mu  sync.Mutex
}

func NewMemoryStore(dir string) (*MemoryStore, error) {
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, err
	}
	return &MemoryStore{dir: dir}, nil
}

func (s *MemoryStore) safePath(sessionID string) (string, error) {
	if !safeIDRe.MatchString(sessionID) || strings.Contains(sessionID, "..") {
		return "", fmt.Errorf("invalid session ID")
	}
	return filepath.Join(s.dir, sessionID+".json"), nil
}

func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func (s *MemoryStore) Create(metadata map[string]string) (*Session, error) {
	now := float64(time.Now().UnixMilli()) / 1000.0
	session := &Session{
		SessionID: newSessionID(),
		CreatedAt: now,
		UpdatedAt: now,
		Messages:  []map[string]interface{}{},
		Metadata:  metadata,
	}
	if err := s.Save(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *MemoryStore) Load(sessionID string) (*Session, error) {
	path, err := s.safePath(sessionID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var session Session
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, err
	}
	return &session, nil
}

func (s *MemoryStore) Save(session *Session) error {
	session.UpdatedAt = float64(time.Now().UnixMilli()) / 1000.0
	path, err := s.safePath(session.SessionID)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.WriteFile(tmp, data, 0640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *MemoryStore) Delete(sessionID string) (bool, error) {
	path, err := s.safePath(sessionID)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(path); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return true, nil
}

func (s *MemoryStore) AppendUser(sessionID, content string) (*Session, error) {
	return s.append(sessionID, map[string]interface{}{"role": "user", "content": content})
}

func (s *MemoryStore) AppendAssistant(sessionID, content string) (*Session, error) {
	return s.append(sessionID, map[string]interface{}{"role": "assistant", "content": content})
}

func (s *MemoryStore) append(sessionID string, message map[string]interface{}) (*Session, error) {
	session, err := s.Load(sessionID)
	if err != nil {
		return nil, err
	}
	if session == nil {
		session = &Session{
			SessionID: sessionID,
			CreatedAt: float64(time.Now().UnixMilli()) / 1000.0,
			Messages:  []map[string]interface{}{},
			Metadata:  map[string]string{},
		}
	}
	session.Messages = append(session.Messages, message)
	return session, s.Save(session)
}

func BuildContextMessages(session *Session, newUserMessage string) []map[string]interface{} {
	msgs := make([]map[string]interface{}, 0)
	if session.Summary != "" {
		msgs = append(msgs,
			map[string]interface{}{"role": "user", "content": "[Prior summary]: " + session.Summary},
			map[string]interface{}{"role": "assistant", "content": "Understood."},
		)
	}
	msgs = append(msgs, session.Messages...)
	msgs = append(msgs, map[string]interface{}{"role": "user", "content": newUserMessage})
	return msgs
}
