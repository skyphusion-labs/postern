// Jenkins pipeline for skyphusion-email (multibranch).
//
// Mirrors the skyphusion-ci job: every green build on `main` deploys the Worker
// to production via `wrangler deploy`. Branch/PR builds run the checks but never
// deploy (the Deploy stage is gated to `main`). The Worker holds no secrets in
// wrangler.jsonc, so there's nothing to inject; RELAY_TOKEN is a Worker secret
// set out of band via `wrangler secret put` and is untouched by `wrangler deploy`.
//
// Required Jenkins credentials (Manage Jenkins -> Credentials):
//   - CLOUDFLARE_API_TOKEN  (Secret text)  Cloudflare API token with "Edit
//                                          Workers" permission. Already present
//                                          on mindcrime-ci (shared with skyphusion-ci).
//   - ghcr-skyphusion       (used by the SCM source to clone this private repo).
//
// Runs each stage in a throwaway Docker container so the box needs only Docker +
// the Docker Pipeline plugin (no host Node or Go). The declarative docker agent
// runs as the Jenkins uid, and HOME/caches point at the workspace so npm and go
// can write without leaving root-owned files behind.

pipeline {
  agent none

  options {
    timeout(time: 20, unit: 'MINUTES')
    disableConcurrentBuilds()
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  stages {
    stage('Worker: typecheck') {
      agent { docker { image 'node:22' } }
      environment {
        HOME = "${env.WORKSPACE}"
        npm_config_cache = "${env.WORKSPACE}/.npm"
        CI = 'true'
      }
      steps {
        dir('worker') {
          sh 'node --version && npm --version'
          sh 'npm ci'
          sh 'npm run typecheck'
        }
      }
    }

    stage('Relay: vet + build') {
      agent { docker { image 'golang:1.23' } }
      environment {
        HOME = "${env.WORKSPACE}"
        GOCACHE = "${env.WORKSPACE}/.gocache"
        GOPATH = "${env.WORKSPACE}/.gopath"
      }
      steps {
        dir('relay') {
          sh 'go version'
          sh 'go vet ./...'
          sh 'go build -o /tmp/skyphusion-email-relay .'
        }
      }
    }

    stage('Deploy worker') {
      // Auto-deploy: every green build on main ships to production. The checks
      // above must pass first, so there is no manual approval gate.
      when { branch 'main' }
      agent { docker { image 'node:22' } }
      environment {
        HOME = "${env.WORKSPACE}"
        npm_config_cache = "${env.WORKSPACE}/.npm"
        CLOUDFLARE_API_TOKEN = credentials('CLOUDFLARE_API_TOKEN')
      }
      steps {
        dir('worker') {
          sh 'npm ci'
          sh 'npx wrangler deploy'
        }
      }
    }
  }
}
