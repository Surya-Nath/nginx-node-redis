output "public_ip"  { value = aws_instance.app.public_ip }
output "public_dns" { value = aws_instance.app.public_dns }
