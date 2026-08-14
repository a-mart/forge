export function preferNodeExtraCaCertsOverOpenSslCaFile() {
  const sslCertFile = process.env.SSL_CERT_FILE?.trim();
  const nodeExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS?.trim();

  if (sslCertFile && nodeExtraCaCerts && sslCertFile === nodeExtraCaCerts) {
    delete process.env.SSL_CERT_FILE;
  }
}
