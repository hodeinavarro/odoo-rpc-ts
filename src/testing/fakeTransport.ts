import { Effect, Layer, Ref } from "effect";
import {
  type CallKwParams,
  Transport,
  type TransportCallError,
  type TransportDialect,
} from "../transport.ts";

/**
 * A single scripted method. Receives the full {@link CallKwParams} of the
 * `call_kw` — `args`, `kwargs`, and the browse `ids` faithfully, because the
 * seam is the contract, not a projection of it — and returns either a bare value
 * (wrapped in `Effect.succeed`) or an `Effect`; the latter lets a handler script
 * a typed transport failure.
 */
export type FakeHandler = (
  params: CallKwParams,
) => Effect.Effect<unknown, TransportCallError> | unknown;

/**
 * Scripted responses keyed by `model` then `method`. Anything not scripted is a
 * test misconfiguration — see the dispatch note in {@link make}.
 */
export type FakeHandlers = {
  readonly [model: string]: {
    readonly [method: string]: FakeHandler;
  };
};

/** A `FakeTransport` layer paired with the log of every call it received. */
export interface FakeTransport {
  readonly layer: Layer.Layer<Transport>;
  /**
   * Every `call_kw` this transport handled, in order, for assertions. Populated
   * before the handler runs, so a failing handler still records its call.
   */
  readonly callLog: Ref.Ref<ReadonlyArray<CallKwParams>>;
}

const isEffect = (
  value: Effect.Effect<unknown, TransportCallError> | unknown,
): value is Effect.Effect<unknown, TransportCallError> => Effect.isEffect(value);

/**
 * Build a deterministic, network-free {@link Transport} from scripted handlers.
 *
 * GOTCHA: an unhandled model/method is a defect in the test, not a runtime
 * condition the code under test could ever encounter — so it is an `Effect.die`
 * (with a precise locator), never a value in the typed failure channel. Tests
 * that mean to exercise a transport failure must script it explicitly.
 */
export const make = (
  handlers: FakeHandlers,
  options?: { readonly dialect?: TransportDialect },
): FakeTransport => {
  const callLog = Ref.makeUnsafe<ReadonlyArray<CallKwParams>>([]);

  const layer = Layer.succeed(Transport, {
    dialect: options?.dialect ?? "execute-kw",
    callKw: (params: CallKwParams) =>
      Effect.gen(function* () {
        const handler = handlers[params.model]?.[params.method];
        if (handler === undefined) {
          // Every real Odoo server answers the seeded default layer's
          // res.users.context_get, so the fake does too — WITHOUT logging it
          // (it is ambient plumbing, and logging it would shift positional
          // log assertions). Script res.users.context_get to observe/override.
          if (params.model === "res.users" && params.method === "context_get") {
            return {};
          }
          yield* Ref.update(callLog, (log) => [...log, params]);
          return yield* Effect.die(
            `FakeTransport: no handler for ${params.model}.${params.method}`,
          );
        }
        yield* Ref.update(callLog, (log) => [...log, params]);

        const result = handler(params);
        return isEffect(result) ? yield* result : result;
      }),
  });

  return { layer, callLog };
};
