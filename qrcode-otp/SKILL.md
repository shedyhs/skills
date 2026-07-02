---
name: qrcode-otp
description: Ler um QRCode de setup de 2FA (URI otpauth://) a partir de uma string ou de uma imagem e gerar o codigo TOTP de 6 digitos (RFC 6238), como um app autenticador (Google Authenticator/Authy). Use quando o usuario pedir para ler um QRCode de autenticacao, extrair o secret de um otpauth://, gerar/calcular um codigo OTP/TOTP/2FA, ou completar o fluxo de autenticacao em dois fatores.
---

# QRCode OTP

Extrai o secret de um QRCode de 2FA (URI `otpauth://totp/...`) e gera o codigo **TOTP** de 6 digitos, valido por uma janela de tempo (padrao 30s). Aceita tanto uma **string otpauth://** quanto uma **imagem** contendo o QRCode.

> Trata apenas **TOTP** (baseado em tempo). HOTP (baseado em contador) nao e suportado.

## Pre-requisito

Os scripts rodam com Node.js. Para gerar codigo a partir de uma **string** otpauth ou de um **secret**, nao ha dependencias (usa `crypto` nativo).

Para ler QRCode de uma **imagem**, instale as dependencias uma vez:
```
! cd /home/shedy/git/skills/qrcode-otp/scripts && npm install
```

## Fluxo

```dot
digraph otp_flow {
    rankdir=TB;
    "Usuario pede o codigo OTP" [shape=box];
    "Tem otpauth:// ou secret?" [shape=diamond];
    "Tem imagem do QRCode?" [shape=diamond];
    "Perguntar a fonte" [shape=box];
    "Ler QR da imagem (--image)" [shape=box];
    "QR contem otpauth?" [shape=diamond];
    "Reportar: QR nao e de 2FA" [shape=box];
    "Gerar TOTP" [shape=box];
    "Reportar codigo + tempo restante" [shape=doublecircle];

    "Usuario pede o codigo OTP" -> "Tem otpauth:// ou secret?";
    "Tem otpauth:// ou secret?" -> "Gerar TOTP" [label="sim"];
    "Tem otpauth:// ou secret?" -> "Tem imagem do QRCode?" [label="nao"];
    "Tem imagem do QRCode?" -> "Ler QR da imagem (--image)" [label="sim"];
    "Tem imagem do QRCode?" -> "Perguntar a fonte" [label="nao"];
    "Perguntar a fonte" -> "Tem otpauth:// ou secret?";
    "Ler QR da imagem (--image)" -> "QR contem otpauth?";
    "QR contem otpauth?" -> "Gerar TOTP" [label="sim"];
    "QR contem otpauth?" -> "Reportar: QR nao e de 2FA" [label="nao"];
    "Gerar TOTP" -> "Reportar codigo + tempo restante";
}
```

## Coleta de Entrada

Identifique a fonte na mensagem do usuario. Pergunte **apenas se nao estiver claro**:

- **URI otpauth://** — cole direto. Contem secret, issuer, algoritmo, digitos e periodo.
- **Secret base32** — o texto que aparece abaixo do QRCode (ex.: `JBSWY3DPEHPK3PXP`). Usa os padroes: 6 digitos, 30s, SHA1.
- **Imagem** (PNG/JPG) — caminho de um arquivo com o QRCode. Requer `npm install` (ver acima).

## Uso dos Scripts

Todos a partir de `/home/shedy/git/skills/qrcode-otp/scripts`.

**A partir de uma string otpauth://** (sem dependencias):
```bash
node otp.mjs "otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme"
```

**A partir de um secret base32** (com parametros opcionais):
```bash
node otp.mjs --secret JBSWY3DPEHPK3PXP --digits 6 --period 30 --algorithm SHA1
```

**A partir de uma imagem** (requer deps instaladas):
```bash
node otp.mjs --image /caminho/do/qrcode.png
```

**Saida estruturada** (para inspecionar issuer, algoritmo, tempo restante):
```bash
node otp.mjs --image /caminho/qr.png --json
```

Saida padrao: o codigo de 6 digitos na stdout e `(valido por mais Ns)` na stderr. Reporte ao usuario o **codigo** e **quanto tempo ainda e valido** — se faltarem poucos segundos, avise que um novo codigo esta prestes a ser gerado.

## Parametros TOTP

| Parametro | Default | Vem da URI otpauth |
|-----------|---------|--------------------|
| `secret` | (obrigatorio) | `?secret=` |
| `digits` | 6 | `?digits=` |
| `period` | 30 (segundos) | `?period=` |
| `algorithm` | SHA1 | `?algorithm=` (SHA1/SHA256/SHA512) |

Ao usar `--image` ou a URI, esses valores sao lidos automaticamente. Ao usar `--secret` puro, os defaults sao aplicados (cobrem a grande maioria dos provedores).

## Seguranca — o secret e sensivel

O `secret` do TOTP e equivalente a uma senha permanente: quem o tem gera codigos validos para sempre. Portanto:

- **Nunca** grave o secret nem a URI otpauth em arquivos versionados, logs ou historico de commits.
- Prefira passar a **imagem** (`--image`) a colar o secret em texto, quando possivel.
- Nao ecoe o secret de volta ao usuario sem necessidade; reporte apenas o **codigo de 6 digitos** gerado.
- Se o secret aparecer em uma mensagem, trate-o como credencial: nao o repita em resumos.

## Exemplo de Uso

Usuario: "gera o codigo desse QR" (anexa `qr.png`)

1. Detectar fonte: imagem → `qr.png`.
2. Garantir deps: se `--image` falhar por dependencia, instruir `npm install` em `scripts/`.
3. Rodar: `node otp.mjs --image qr.png --json`.
4. Reportar: "Codigo: **287082** (valido por mais 18s, issuer Acme)."
