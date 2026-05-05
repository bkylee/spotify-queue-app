output "app_url" {
  description = "URL of the deployed web app"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}"
}

output "auth_url" {
  description = "URL to authorize your Spotify account"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}/auth/login"
}

output "admin_url" {
  description = "URL for the admin dashboard"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}/admin.html"
}
