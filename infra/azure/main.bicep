// ACCESS execution plane on Azure Container Apps.
//
// Runtime contract (matches packages/config):
//   API     -> API_DATABASE_URL     (access_request login)
//   worker  -> WORKER_DATABASE_URL  (access_worker login)
//   job     -> MIGRATION_DATABASE_URL (schema owner; migration job only)
// The migration credential is never given to the API or the worker.
// Secrets are read from an existing Key Vault through a user-assigned
// identity, so no secret value passes through deployment parameters.
targetScope = 'resourceGroup'

@description('Globally unique prefix for resource names')
param prefix string

@allowed([
  'northeurope'
  'westeurope'
  'southafricanorth'
])
param location string = 'westeurope'

@description('Immutable image reference, e.g. myregistry.azurecr.io/access@sha256:...')
param image string

@description('Registry server for image pulls with the managed identity (empty for a public image). Grant AcrPull to the identity output first.')
param registryServer string = ''

@allowed([
  'synthetic-staging'
  'client-pilot'
  'production'
])
param deploymentProfile string = 'client-pilot'

@allowed([
  'SYNTHETIC'
  'REAL'
])
@description('REAL only after every client-pilot checklist gate has passed (docs/client-pilot-checklist.md)')
param dataMode string = 'SYNTHETIC'

@description('Existing Key Vault (same resource group) holding the secrets listed in docs/deployment.md')
param keyVaultName string

@description('Supabase project URL, e.g. https://<ref>.supabase.co')
param supabaseUrl string

@description('Private Supabase Storage bucket for encrypted artifacts')
param storageBucket string = 'access-artifacts'

@description('Supabase Auth issuer, e.g. https://<ref>.supabase.co/auth/v1')
param authIssuer string

param authAudience string = 'authenticated'

@description('Supabase Auth JWKS, e.g. https://<ref>.supabase.co/auth/v1/.well-known/jwks.json')
param authJwksUrl string

@description('Exact https origin of the staff console (no wildcard)')
param consoleOrigin string

@allowed([
  'none'
  'mock'
])
@description('No real connector is qualified yet: use none (manual destination) for REAL data')
param connectorKind string = 'none'

param dispatchMaxAttempts int = 5
param dispatchRetrySeconds int = 30
param reconcileMaxAttempts int = 8
param reconcileBaseSeconds int = 30
param artifactRetentionDays int = 2555

@description('ClamAV daemon image, run as a sidecar of the API')
param clamavImage string = 'docker.io/clamav/clamav:stable'

var keyVaultSecretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-runtime'
  location: location
}

resource secretsAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultSecretsUserRole)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRole)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    retentionInDays: 90
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var managedIdentity = {
  type: 'UserAssigned'
  userAssignedIdentities: {
    '${identity.id}': {}
  }
}
var registries = empty(registryServer)
  ? []
  : [
      {
        server: registryServer
        identity: identity.id
      }
    ]
func kvSecret(vaultUri string, name string, identityId string) object => {
  name: name
  keyVaultUrl: '${vaultUri}secrets/${name}'
  identity: identityId
}

var commonEnv = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'ACCESS_DEPLOYMENT_PROFILE'
    value: deploymentProfile
  }
  {
    name: 'ACCESS_DATA_MODE'
    value: dataMode
  }
  {
    name: 'DATABASE_SSL'
    value: 'require'
  }
  {
    name: 'DATABASE_CA_CERT'
    secretRef: 'database-ca-cert'
  }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  identity: managedIdentity
  dependsOn: [
    secretsAccess
  ]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3001
        transport: 'http'
        allowInsecure: false
      }
      registries: registries
      secrets: [
        kvSecret(vault.properties.vaultUri, 'api-database-url', identity.id)
        kvSecret(vault.properties.vaultUri, 'database-ca-cert', identity.id)
        kvSecret(vault.properties.vaultUri, 'artifact-encryption-key', identity.id)
        kvSecret(vault.properties.vaultUri, 'supabase-service-role-key', identity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          env: concat(commonEnv, [
            {
              name: 'API_DATABASE_URL'
              secretRef: 'api-database-url'
            }
            {
              name: 'ARTIFACT_ENCRYPTION_KEY'
              secretRef: 'artifact-encryption-key'
            }
            {
              name: 'ARTIFACT_STORE'
              value: 'supabase'
            }
            {
              name: 'SUPABASE_URL'
              value: supabaseUrl
            }
            {
              name: 'SUPABASE_STORAGE_BUCKET'
              value: storageBucket
            }
            {
              name: 'SUPABASE_SERVICE_ROLE_KEY'
              secretRef: 'supabase-service-role-key'
            }
            {
              name: 'ARTIFACT_RETENTION_DAYS'
              value: string(artifactRetentionDays)
            }
            {
              name: 'ARTIFACT_SCANNER'
              value: 'clamav'
            }
            {
              name: 'CLAMAV_HOST'
              value: '127.0.0.1'
            }
            {
              name: 'CLAMAV_PORT'
              value: '3310'
            }
            {
              name: 'ACCESS_AUTH_MODE'
              value: 'jwt'
            }
            {
              name: 'AUTH_JWT_ISSUER'
              value: authIssuer
            }
            {
              name: 'AUTH_JWT_AUDIENCE'
              value: authAudience
            }
            {
              name: 'AUTH_JWKS_URL'
              value: authJwksUrl
            }
            {
              name: 'CONSOLE_ORIGIN'
              value: consoleOrigin
            }
            {
              name: 'BUILD_ID'
              value: image
            }
          ])
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 3001
              }
              periodSeconds: 10
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3001
              }
              periodSeconds: 30
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
        {
          // File-safety gate: the API streams every upload to clamd (INSTREAM)
          // on localhost before anything is stored or extracted.
          name: 'clamav'
          image: clamavImage
          resources: {
            cpu: json('1.25')
            memory: '2.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-worker'
  location: location
  identity: managedIdentity
  dependsOn: [
    secretsAccess
  ]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      registries: registries
      secrets: [
        kvSecret(vault.properties.vaultUri, 'worker-database-url', identity.id)
        kvSecret(vault.properties.vaultUri, 'database-ca-cert', identity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: [
            'node'
            'apps/worker/dist/main.js'
          ]
          env: concat(commonEnv, [
            {
              name: 'WORKER_DATABASE_URL'
              secretRef: 'worker-database-url'
            }
            {
              name: 'CONNECTOR_KIND'
              value: connectorKind
            }
            {
              name: 'DISPATCH_MAX_ATTEMPTS'
              value: string(dispatchMaxAttempts)
            }
            {
              name: 'DISPATCH_RETRY_SECONDS'
              value: string(dispatchRetrySeconds)
            }
            {
              name: 'RECONCILE_MAX_ATTEMPTS'
              value: string(reconcileMaxAttempts)
            }
            {
              name: 'RECONCILE_BASE_SECONDS'
              value: string(reconcileBaseSeconds)
            }
          ])
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      // Dispatch is safe with several replicas (SKIP LOCKED + lease fencing);
      // one replica keeps the pilot simple to observe.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

// Ordered, checksummed migrations. Started manually by infra/azure/deploy.sh
// before new API/worker revisions receive traffic.
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-migrate'
  location: location
  identity: managedIdentity
  dependsOn: [
    secretsAccess
  ]
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registries
      secrets: [
        kvSecret(vault.properties.vaultUri, 'migration-database-url', identity.id)
        kvSecret(vault.properties.vaultUri, 'database-ca-cert', identity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          command: [
            'node'
            'packages/db/dist/migrate.js'
          ]
          env: concat(commonEnv, [
            {
              name: 'MIGRATION_DATABASE_URL'
              secretRef: 'migration-database-url'
            }
          ])
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output apiHost string = api.properties.configuration.ingress.fqdn
output runtimeIdentityPrincipalId string = identity.properties.principalId
output migrationJobName string = migrate.name
