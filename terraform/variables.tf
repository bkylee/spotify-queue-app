variable "app_name" {
  description = "Globally unique name for the Azure Web App"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the Azure resource group"
  type        = string
}

variable "location" {
  description = "Azure region to deploy to (e.g. canadacentral, eastus, westeurope)"
  type        = string
  default     = "canadacentral"
}

variable "sku_name" {
  description = "App Service plan SKU (F1 = free, B1 = basic ~$13/mo)"
  type        = string
  default     = "F1"
}

variable "service_plan_id" {
  description = "Full Azure resource ID of the App Service Plan"
  type        = string
}

variable "storage_account_name" {
  description = "Globally unique name for Azure Storage Account (3-24 chars, lowercase letters and numbers only)"
  type        = string
}

variable "host_name" {
  description = "The host's name shown in the guest UI (e.g. 'Brian' shows as \"Update Brian's Queue\")"
  type        = string
  default     = "Your Host"
}

variable "spotify_client_id" {
  description = "Spotify app Client ID"
  type        = string
  sensitive   = true
}

variable "spotify_client_secret" {
  description = "Spotify app Client Secret"
  type        = string
  sensitive   = true
}

variable "spotify_refresh_token" {
  description = "Spotify refresh token (generated after /auth/login)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_password" {
  description = "Password for the /admin.html page"
  type        = string
  sensitive   = true
}
