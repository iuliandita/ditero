# Trusted Proxy Configuration

Set `DITERO_TRUSTED_PROXIES` to comma-separated CIDRs for proxies that connect directly to Ditero:

```sh
DITERO_TRUSTED_PROXIES='10.20.0.0/16,2001:db8:1234::/48'
```

Ditero evaluates `X-Forwarded-For` from right to left only when the socket peer matches this list. With no trusted CIDRs, forwarding headers are discarded and the socket peer is used for throttling.

Keep Ditero unreachable except through the listed proxy, replace incoming forwarding headers at the edge, and set `BETTER_AUTH_URL` to the public HTTPS origin. After changing the proxy path, verify that two clients receive independent rate-limit buckets and that a direct request cannot spoof its address.

A household behind NAT or a VPN gateway can legitimately share one client address.
Proxy configuration cannot recover individual addresses hidden by that gateway;
do not trust client-supplied headers to separate those members. Email sign-in uses
a shared PostgreSQL bucket per client IP and normalized email: five initial attempts,
then one attempt refilled every 12 seconds. A member exhausting that bucket does
not exhaust another email's bucket. Existing and unknown emails receive the same
throttling response. Sign-in also has a shared ceiling of 30 requests per minute
per IP, so sustained abuse can still temporarily block everyone at that address.
Sign-up allows 10 per minute, two-factor routes 30 per minute, and each of
`/get-session` and `/token` 600 per minute per IP. TOTP account lockout remains
five failed attempts for 15 minutes. See [Security Architecture](../security.md).
