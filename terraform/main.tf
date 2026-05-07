terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
  required_version = ">= 1.3.0"
}

provider "azurerm" {
  features {}
}

# ── Storage Account ───────────────────────────────────────────────────

resource "azurerm_storage_account" "main" {
  name                     = var.storage_account_name
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
}

resource "azurerm_storage_table" "settings" {
  name                 = "settings"
  storage_account_name = azurerm_storage_account.main.name
}

resource "azurerm_storage_table" "blocklist" {
  name                 = "blocklist"
  storage_account_name = azurerm_storage_account.main.name
}

resource "azurerm_storage_table" "reactions" {
  name                 = "reactions"
  storage_account_name = azurerm_storage_account.main.name
}

resource "azurerm_storage_table" "leaderboard" {
  name                 = "leaderboard"
  storage_account_name = azurerm_storage_account.main.name
}

resource "azurerm_storage_table" "activitylog" {
  name                 = "activitylog"
  storage_account_name = azurerm_storage_account.main.name
}

# ── Web App ───────────────────────────────────────────────────────────

resource "azurerm_linux_web_app" "main" {
  name                    = var.app_name
  resource_group_name     = var.resource_group_name
  location                = var.location
  service_plan_id         = var.service_plan_id
  https_only              = true
  client_affinity_enabled = true

  site_config {
    always_on        = var.sku_name == "B1" ? false : true
    http2_enabled    = true
    app_command_line = "node server.js"

    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = {
    SPOTIFY_CLIENT_ID               = var.spotify_client_id
    SPOTIFY_CLIENT_SECRET           = var.spotify_client_secret
    REDIRECT_URI                    = "https://${var.app_name}.azurewebsites.net/callback"
    SPOTIFY_REFRESH_TOKEN           = var.spotify_refresh_token
    ADMIN_PASSWORD                  = var.admin_password
    HOST_NAME                       = var.host_name
    NODE_ENV                        = "production"
    SCM_DO_BUILD_DURING_DEPLOYMENT  = "True"
    AZURE_STORAGE_CONNECTION_STRING = azurerm_storage_account.main.primary_connection_string
  }

  logs {
    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
    application_logs {
      file_system_level = "Information"
    }
  }
}
