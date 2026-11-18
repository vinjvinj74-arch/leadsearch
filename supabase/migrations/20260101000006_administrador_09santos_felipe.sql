-- Super administrador adicional.
-- O papel super_admin ja concede acesso ilimitado: nao consome creditos e
-- nao exige assinatura ativa (ver src/services/subscriptionService.ts).
UPDATE users SET role = 'super_admin', updated_at = now()
WHERE lower(email) = lower('09santos.felipe@gmail.com')
  AND role <> 'super_admin';
