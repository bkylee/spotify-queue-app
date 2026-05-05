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
  location                 = "canadacentral"
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
# Resource group and App Service Plan are managed outside of Terraform
# (the plan name contains dots which the azurerm provider rejects).

resource "azurerm_linux_web_app" "main" {
  name                    = var.app_name
  resource_group_name     = var.resource_group_name
  location                = "canadacentral"
  service_plan_id         = "/subscriptions/ea0c6b3f-d251-437e-b139-58f867a732e2/resourceGroups/learn-7d094fbd-dd2b-4679-a3a1-20f48cfb12a2/providers/Microsoft.Web/serverFarms/brian.ky.lee_asp_6113"
  https_only              = true
  client_affinity_enabled = true

  site_config {
    always_on        = false
    http2_enabled    = true
    app_command_line = "node server.js"

    application_stack {
      node_version = "18-lts"
    }
  }

  app_settings = {
    SPOTIFY_CLIENT_ID              = var.spotify_client_id
    SPOTIFY_CLIENT_SECRET          = var.spotify_client_secret
    REDIRECT_URI                   = "https://${var.app_name}.azurewebsites.net/callback"
    SPOTIFY_REFRESH_TOKEN          = var.spotify_refresh_token
    ADMIN_PASSWORD                 = var.admin_password
    NODE_ENV                       = "production"
    SCM_DO_BUILD_DURING_DEPLOYMENT = "True"
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
