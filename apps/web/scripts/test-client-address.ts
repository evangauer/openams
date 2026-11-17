import assert from "node:assert/strict";
import { clientAddress, clientAddressDepth } from "../src/lib/server/client-address";

// Fictional documentation addresses only (RFC 5737, RFC 3849).
assert.equal(clientAddressDepth({}), 0);
assert.equal(clientAddressDepth({ AMS_CLIENT_ADDRESS_DEPTH: "2" }), 2);
assert.equal(clientAddressDepth({ AMS_CLIENT_ADDRESS_DEPTH: "-1" }), 0);
assert.equal(clientAddressDepth({ AMS_CLIENT_ADDRESS_DEPTH: "two" }), 0);

// Unset: nothing is trusted, whatever the client sends.
assert.equal(clientAddress("198.51.100.7", 0), null);

// A Google Cloud load balancer appends "<client>, <load balancer>": depth 2.
assert.equal(clientAddress("198.51.100.7, 203.0.113.10", 2), "198.51.100.7");
// A client-supplied prefix cannot move the trusted position.
assert.equal(clientAddress("192.0.2.1, 192.0.2.2, 198.51.100.7, 203.0.113.10", 2), "198.51.100.7");
// Fewer entries than the proxies always append: no trusted address.
assert.equal(clientAddress("203.0.113.10", 2), null);
assert.equal(clientAddress(null, 2), null);
// A single reverse proxy: depth 1.
assert.equal(clientAddress("192.0.2.1, 198.51.100.7", 1), "198.51.100.7");

// IPv6 is keyed by its /64, so rotating within a subscriber's prefix doesn't help.
assert.equal(clientAddress("2001:db8:a:b:1:2:3:4, 203.0.113.10", 2), "2001:db8:a:b::/64");
assert.equal(clientAddress("2001:DB8:A:B::99, 203.0.113.10", 2), "2001:db8:a:b::/64");
assert.equal(clientAddress("2001:db8::1, 203.0.113.10", 2), "2001:db8:0:0::/64");
// IPv4-mapped IPv6 is the IPv4 address.
assert.equal(clientAddress("::ffff:198.51.100.7", 1), "198.51.100.7");
// Anything that isn't an address is not trusted.
assert.equal(clientAddress("unknown, 203.0.113.10", 2), null);
assert.equal(clientAddress("198.51.100.7:443, 203.0.113.10", 2), null);

console.log("client address: ok");
