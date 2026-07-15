package main

import "github.com/emersion/go-sasl"

// Local LOGIN server. go-sasl dropped NewLoginServer (obsolete mechanism;
// emersion's guidance is to vendor it if you still need legacy MUAs). Kept for
// AUTH LOGIN over submission; PLAIN remains primary.

type loginAuthenticator func(username, password string) error

type loginState int

const (
	loginNotStarted loginState = iota
	loginWaitingUsername
	loginWaitingPassword
)

type loginServer struct {
	state        loginState
	username     string
	password     string
	authenticate loginAuthenticator
}

func newLoginServer(authenticator loginAuthenticator) sasl.Server {
	return &loginServer{authenticate: authenticator}
}

func (a *loginServer) Next(response []byte) (challenge []byte, done bool, err error) {
	switch a.state {
	case loginNotStarted:
		// Initial response field per RFC 4422 section 3.
		if response == nil {
			challenge = []byte("Username:")
			break
		}
		a.state++
		fallthrough
	case loginWaitingUsername:
		a.username = string(response)
		challenge = []byte("Password:")
	case loginWaitingPassword:
		a.password = string(response)
		err = a.authenticate(a.username, a.password)
		done = true
	default:
		err = sasl.ErrUnexpectedClientResponse
	}

	a.state++
	return
}
