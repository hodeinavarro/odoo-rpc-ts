/**
 * odoo-rpc-ts/testing — deterministic test doubles.
 *
 * `FakeTransport` is a scripted, network-free {@link Transport} implementation
 * (AGENTS.md § Testing export). Compose its `.layer` under the service you want
 * to exercise and assert against its `.callLog`.
 */

export { make, type FakeHandler, type FakeHandlers, type FakeTransport } from "./fakeTransport.ts";
