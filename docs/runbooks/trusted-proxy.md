# Trusted Proxy Configuration

Set `DITERO_TRUSTED_PROXIES` to comma-separated CIDRs for proxies that connect directly to Ditero:

```sh
DITERO_TRUSTED_PROXIES='10.20.0.0/16,2001:db8:1234::/48'
```

Ditero evaluates `X-Forwarded-For` from right to left only when the socket peer matches this list. With no trusted CIDRs, forwarding headers are discarded and the socket peer is used for throttling.

Keep Ditero unreachable except through the listed proxy, replace incoming forwarding headers at the edge, and set `BETTER_AUTH_URL` to the public HTTPS origin. After changing the proxy path, verify that two clients receive independent rate-limit buckets and that a direct request cannot spoof its address.

For attachment uploads, set the proxy body limit (for example, nginx `client_max_body_size`) at least as high as the `maxFileBytes` value returned by `/api/attachments/config`. That application limit counts encrypted bytes, including framing overhead; content and thumbnail requests each pass through the proxy. A smaller proxy limit rejects uploads with HTTP 413 before Ditero can accept them.
