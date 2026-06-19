// Jenkins pipeline for skyphusion-email (multibranch).
//
// Every green build on `main` deploys both Workers to production via
// `wrangler deploy`. Branch/PR builds run the checks but never deploy.
//
// "Green" means typecheck AND the test suites pass: worker (vitest), inbound
// (vitest), relay (go test -race). Deploy is gated behind all of them, so a
// regression cannot reach production on a green build.
//
// Required Jenkins credentials (Manage Jenkins -> Credentials):
//   - CLOUDFLARE_API_TOKEN  (Secret text)  CF API token with Workers + D1 +
//                                          Vectorize edit permissions.
//   - ghcr-skyphusion       (used by the SCM source to clone this private repo).
//
// Workers deployed:
//   worker/   -> skyphusion-email          (outbound sending)
//   inbound/  -> skyphusion-email-inbound  (CF Email Routing ingestion)
//
// Runs each stage in a throwaway Docker container (no host Node or Go needed).
// HOME and caches point at WORKSPACE so npm/go can write without root-owned files.

pipeline {
  agent none

  options {
    timeout(time: 20, unit: 'MINUTES')
    disableConcurrentBuilds()
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  stages {
    stage('Worker: typecheck + test') {
      agent { docker { image 'node:22' } }
      environment {
        HOME = "${env.WORKSPACE}"
        npm_config_cache = "${env.WORKSPACE}/.npm"
        CI = 'true'
      }
      steps {
        dir('worker') {
          sh 'npm ci'
          sh 'npm run typecheck'
          sh 'npm test'
        }
      }
    }

    stage('Inbound: typecheck + test') {
      agent { docker { image 'node:22' } }
      environment {
        HOME = "${env.WORKSPACE}"
        npm_config_cache = "${env.WORKSPACE}/.npm"
        CI = 'true'
      }
      steps {
        dir('inbound') {
          sh 'npm ci'
          sh 'npm run typecheck'
          sh 'npm test'
        }
      }
    }

    stage('Relay: vet + build + test') {
      // Pin to the go.mod toolchain (1.22); matches the GitHub Actions setup-go.
      agent { docker { image 'golang:1.22' } }
      environment {
        HOME = "${env.WORKSPACE}"
        GOCACHE = "${env.WORKSPACE}/.gocache"
        GOPATH = "${env.WORKSPACE}/.gopath"
      }
      steps {
        dir('relay') {
          sh 'go vet ./...'
          sh 'go build -o /tmp/skyphusion-email-relay .'
          sh 'go test -race ./...'
        }
      }
    }

    stage('Deploy') {
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
        dir('inbound') {
          sh 'npm ci'
          sh 'npx wrangler deploy'
        }
      }
    }
  }

  post {
    failure {
      mail to: 'conrad@rockenhaus.net',
           subject: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER}",
           body: "Build failed: ${env.BUILD_URL}"
    }
  }
}
