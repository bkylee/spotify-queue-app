output "app_url" {
  description = "URL of the deployed web app"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}"
}

output "auth_url" {
  description = "URL to authorize your Spotify account (visit once after deploy)"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}/auth/login"
}

output "admin_url" {
  description = "URL for the admin dashboard"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}/admin.html"
}

output "storage_account_name" {
  description = "Name of the Azure Storage Account"
  value       = azurerm_storage_account.main.name
}

output "storage_connection_string" {
  description = "Storage account connection string (injected into app automatically)"
  value       = azurerm_storage_account.main.primary_connection_string
  sensitive   = true
}
