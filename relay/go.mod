module github.com/skyphusion/skyphusion-email/relay

go 1.25.0

// Build toolchain pinned to a PATCHED release (audit #107). govulncheck flags
// standard-library CVEs against the toolchain version. CI reads this directive
// through setup-go (go-version-file), so this pin is what the gate measures.
//
// go1.26.9 is the LOWEST release that clears the 2026-10-08 advisory batch.
// That batch is GO-2026-6603 / 6605 / 6607 / 6608 / 6610 / 6611 / 6612 / 6613 /
// 6617. It produced nine affecting findings in net/http, net/textproto and
// crypto/tls. Those advisories publish no 1.25-line fix. go1.25.14, the newest
// 1.25 release, still scans red. So this batch forced a MINOR-line move, not the
// patch bump the previous note here assumed. A later stdlib CVE may force the
// same. Bump to whatever release the advisory names as fixed, minor line
// included. relay/README.md carries the measurements.
//
// Do NOT jump to the 1.27 line yet. govulncheck v1.5.0, the pin in ci.yml,
// cannot type-check a go1.27 stdlib. It exits 1 on a load error instead of
// returning a verdict, so the gate stops answering. Bump that tool pin first,
// then prove the gate still goes red on an old toolchain.
//
// The `go` directive above stays at 1.25.0 on purpose. It sets the LANGUAGE
// version, which this security bump does not need to move. A toolchain above the
// language version is legal and is the normal shape for a security pin.
//
// relay/Dockerfile builds the shipped binary and MUST stay on this same line
// (#539 / #541). Bump both in one commit.
toolchain go1.26.9

require (
	github.com/emersion/go-sasl v0.0.0-20241020182733-b788ff22d5a6
	github.com/emersion/go-smtp v0.25.0
	github.com/go-ldap/ldap/v3 v3.4.14
	github.com/jhillyerd/enmime v1.3.0
	github.com/msteinert/pam v1.2.0
)

require (
	github.com/Azure/go-ntlmssp v0.1.1 // indirect
	github.com/cention-sany/utf7 v0.0.0-20170124080048-26cad61bd60a // indirect
	github.com/go-asn1-ber/asn1-ber v1.5.8 // indirect
	github.com/gogs/chardet v0.0.0-20211120154057-b7413eaefb8f // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jaytaylor/html2text v0.0.0-20230321000545-74c2419ad056 // indirect
	github.com/mattn/go-runewidth v0.0.15 // indirect
	github.com/olekukonko/tablewriter v0.0.5 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/rivo/uniseg v0.4.4 // indirect
	github.com/ssor/bom v0.0.0-20170718123548-6386211fdfcf // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/text v0.40.0 // indirect
)
