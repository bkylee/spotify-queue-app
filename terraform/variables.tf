
variable "app_name" {
  description = "The globally unique name for the Azure Web App"
  type        = string
  default     = "spotify-queue-neon-fox"
}

variable "resource_group_name" {
  description = "Name of the Azure resource group"
  type        = string
  default     = "learn-7d094fbd-dd2b-4679-a3a1-20f48cfb12a2"
}

variable "location" {
  description = "Azure region to deploy to"
  type        = string
  default     = "eastus"
}

variable "sku_name" {
  description = "App Service plan SKU (F1 = free, B1 = basic ~$13/mo)"
  type        = string
  default     = "F1"
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
