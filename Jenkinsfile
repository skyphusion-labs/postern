// Jenkins pipeline for skyphusion-email (multibranch).
//
// Every green build on `main` deploys both Workers to production via
// `wrangler deploy`. Branch/PR builds run the checks but never deploy.
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
    // Single checkout so parallel stages don't race on the same workspace ref.
    stage('Checkout') {
      agent any
      steps {
        checkout scm
        stash name: 'source', useDefaultExcludes: false
      }
    }

    stage('Check') {
      parallel {
        stage('Worker: typecheck') {
          agent { docker { image 'node:22' } }
          options { skipDefaultCheckout() }
          environment {
            HOME = "${env.WORKSPACE}"
            npm_config_cache = "${env.WORKSPACE}/.npm"
            CI = 'true'
          }
          steps {
            unstash 'source'
            dir('worker') {
              sh 'npm ci'
              sh 'npm run typecheck'
            }
          }
        }

        stage('Inbound: typecheck') {
          agent { docker { image 'node:22' } }
          options { skipDefaultCheckout() }
          environment {
            HOME = "${env.WORKSPACE}"
            npm_config_cache = "${env.WORKSPACE}/.npm"
            CI = 'true'
          }
          steps {
            unstash 'source'
            dir('inbound') {
              sh 'npm ci'
              sh 'npm run typecheck'
            }
          }
        }

        stage('Relay: vet + build') {
          agent { docker { image 'golang:1.23' } }
          options { skipDefaultCheckout() }
          environment {
            HOME = "${env.WORKSPACE}"
            GOCACHE = "${env.WORKSPACE}/.gocache"
            GOPATH = "${env.WORKSPACE}/.gopath"
          }
          steps {
            unstash 'source'
            dir('relay') {
              sh 'go vet ./...'
              sh 'go build -o /tmp/skyphusion-email-relay .'
            }
          }
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
