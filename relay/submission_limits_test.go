package main

import (
	"net"
	"testing"
	"time"
)

func TestSubmissionServerSetsReadAndWriteTimeouts(t *testing.T) {
	cfg := Config{}
	cfg.Submission.ReadTimeout = 5 * time.Minute
	cfg.Submission.WriteTimeout = 5 * time.Minute
	srv := newSubmissionServer(nil, nil, cfg)
	if srv.ReadTimeout != 5*time.Minute || srv.WriteTimeout != 5*time.Minute {
		t.Fatalf("read=%s write=%s, want 5m/5m", srv.ReadTimeout, srv.WriteTimeout)
	}
}

func TestCappedListenerRefusesPastTheCap(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	capped := newCappedListener(ln, 1)
	defer capped.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := capped.Accept()
		if err != nil {
			return
		}
		accepted <- c
		// Keep accepting so a connection past the cap is closed here.
		for {
			c, err = capped.Accept()
			if err != nil {
				return
			}
			accepted <- c
		}
	}()

	hold, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Close()
	first := <-accepted
	defer first.Close()

	extra, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	_ = extra.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 8)
	n, err := extra.Read(buf)
	if err == nil {
		t.Fatalf("connection past the cap stayed open, read %d bytes", n)
	}
}
