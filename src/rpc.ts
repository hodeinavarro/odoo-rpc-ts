import { Context, Effect, Layer, Option, Schema } from "effect";
import { SchemaDriftError } from "./errors/schema.ts";
import * as SingleFlight from "./internal/singleFlight.ts";
import {
  type CallKwParams,
  Transport,
  type TransportCallError,
  type TransportDialect,
} from "./transport.ts";

/** An Odoo `context` dict: opaque keys, values we do not model. */
export type OdooContext = Record<string, unknown>;

/** A plain object (a mergeable context), excluding arrays and `null`. */
const isPlainObject = (value: unknown): value is OdooContext =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Copy `kwargs` without its `context` key (never mutates the caller's object). */
const omitContext = (kwargs: OdooContext): OdooContext => {
  const { context: _context, ...rest } = kwargs;
  return rest;
};

/**
 * The session/base Odoo `context` — the innermost, lowest-precedence layer of
 * the context merge (e.g. `uid`, `lang`, `tz` established at authentication).
 *
 * Provided by the auth/transport layer that owns the session; absent here it
 * defaults to `{}`. It is read once, when the {@link Rpc} layer is built.
 */
export class GlobalContext extends Context.Tag("odoo-rpc-ts/GlobalContext")<
  GlobalContext,
  OdooContext
>() {}

/**
 * The `call_kw` choke point. Every high-level operation funnels through here so
 * the Odoo `context` is merged in exactly one place, with a single, documented
 * precedence (see {@link callKw}).
 */
export class Rpc extends Context.Tag("odoo-rpc-ts/Rpc")<
  Rpc,
  {
    /** The underlying transport's wire dialect, for ops that must branch on it. */
    readonly dialect: TransportDialect;
    /**
     * Execute one `call_kw`, merging the effective `context` and forwarding to
     * the {@link Transport}. Caller inputs are never mutated — `args`, `kwargs`,
     * and every context object are treated as read-only and copied.
     *
     * Context precedence (lowest → highest, later wins):
     *   session/base ({@link GlobalContext}) < layer overrides
     *     < `kwargs.context` < `options.context`.
     *
     * A `context` key inside `kwargs` is treated as a caller-level context (the
     * ergonomic form `callKw(m, meth, [], { context })`), merged just below
     * `options.context` and then stripped from `kwargs` so it never wires twice.
     * If it is present but not a plain object it is a caller defect and fails
     * with `Effect.die`.
     */
    readonly callKw: (
      model: string,
      method: string,
      args: ReadonlyArray<unknown>,
      kwargs?: OdooContext,
      options?: { readonly context?: OdooContext; readonly ids?: ReadonlyArray<number> },
    ) => Effect.Effect<unknown, TransportCallError>;
  }
>() {}

/**
 * The provider seam for a lazily-seeded session/base context.
 *
 * A `Layer` resolves eagerly at build time, but the base tier must be lazy and
 * retryable-on-failure (a transport error resolving it must surface as the
 * failing call's error, never be baked in). So instead of a value provider we
 * take an `Effect` that yields the base context; {@link buildRpc} runs it behind
 * a success-only single-flight on the FIRST `callKw` (and retries on failure).
 *
 * Merge position: below the layer overrides, above the static {@link GlobalContext}
 * tag (which, when both are present, seeds the innermost defaults).
 */
export type GlobalContextProvider = Effect.Effect<OdooContext, TransportCallError>;

const ContextRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/**
 * Decode a raw `res.users.context_get` result into an {@link OdooContext};
 * drift (a non-object payload) fails as {@link SchemaDriftError}, which is part
 * of {@link TransportCallError} and so propagates as the seeding call's error.
 */
const decodeContext = (raw: unknown): Effect.Effect<OdooContext, SchemaDriftError> =>
  Schema.decodeUnknown(ContextRecord)(raw).pipe(
    Effect.mapError(
      (cause) => new SchemaDriftError({ context: "res.users.context_get", payload: raw, cause }),
    ),
  );

/**
 * The shared {@link Rpc} service constructor. `provider`, when given, seeds the
 * base tier lazily (single-flight on first call). The static {@link GlobalContext}
 * tag is always read (defaulting to `{}`) and sits at the very bottom.
 */
const buildRpc = (
  transport: Context.Tag.Service<Transport>,
  config: { readonly globalContext?: OdooContext } | undefined,
  provider: GlobalContextProvider | undefined,
): Effect.Effect<Context.Tag.Service<Rpc>> =>
  Effect.gen(function* () {
    const staticBase = Option.getOrElse(
      yield* Effect.serviceOption(GlobalContext),
      (): OdooContext => ({}),
    );
    const layerOverrides = config?.globalContext ?? {};

    // No provider: the base tier is the static tag value (today's behavior,
    // resolved once at build). With a provider: resolve it lazily behind a
    // success-only single-flight and layer it over the static base.
    const resolveBase: Effect.Effect<OdooContext, TransportCallError> =
      provider === undefined
        ? Effect.succeed(staticBase)
        : yield* SingleFlight.make(provider).pipe(
            Effect.map((sf) =>
              sf.get.pipe(Effect.map((seeded): OdooContext => ({ ...staticBase, ...seeded }))),
            ),
          );

    const callKw = (
      model: string,
      method: string,
      args: ReadonlyArray<unknown>,
      kwargs?: OdooContext,
      options?: { readonly context?: OdooContext; readonly ids?: ReadonlyArray<number> },
    ): Effect.Effect<unknown, TransportCallError> => {
      // Pull any caller-supplied `kwargs.context` out of the spread so it is
      // merged at the caller tier (not silently clobbered) and never wired twice.
      const hasKwargsContext = kwargs !== undefined && "context" in kwargs;
      const kwargsContext = hasKwargsContext ? kwargs["context"] : undefined;
      if (hasKwargsContext && !isPlainObject(kwargsContext)) {
        return Effect.die(
          `Rpc.callKw: kwargs.context for "${model}.${method}" must be a plain object, ` +
            `got ${typeof kwargsContext}.`,
        );
      }
      const restKwargs = hasKwargsContext ? omitContext(kwargs) : (kwargs ?? {});

      return resolveBase.pipe(
        Effect.flatMap((base) => {
          const context: OdooContext = {
            ...base,
            ...layerOverrides,
            ...(kwargsContext as OdooContext | undefined),
            ...options?.context,
          };
          const params: CallKwParams = {
            model,
            method,
            args,
            kwargs: { ...restKwargs, context },
            ...(options?.ids !== undefined ? { ids: options.ids } : {}),
          };
          return transport.callKw(params);
        }),
      );
    };

    return { dialect: transport.dialect, callKw };
  });

/**
 * Build the {@link Rpc} layer over a {@link Transport}, optionally baking in
 * layer-level `globalContext` overrides that sit above the session/base context
 * but below any per-call context, and/or a {@link GlobalContextProvider} that
 * lazily seeds the base tier on the first call.
 */
export const layerWith = (config?: {
  readonly globalContext?: OdooContext;
  readonly globalContextProvider?: GlobalContextProvider;
}): Layer.Layer<Rpc, never, Transport> =>
  Layer.effect(
    Rpc,
    Effect.gen(function* () {
      const transport = yield* Transport;
      return yield* buildRpc(transport, config, config?.globalContextProvider);
    }),
  );

/**
 * The {@link Rpc} layer with the base tier seeded from the ambient
 * {@link Transport}'s server-side user context.
 *
 * Resolves `res.users.context_get` (an `@api.model` method — kwargs-only, so it
 * works identically over `execute_kw` and the JSON-2 by-name dialect) exactly
 * once, lazily on the first `callKw`, behind a success-only single-flight. A
 * transport/decoding failure while seeding is NOT swallowed: it surfaces as that
 * first call's error and the seed is retried on the next call.
 */
export const layerSeeded = (config?: {
  readonly globalContext?: OdooContext;
}): Layer.Layer<Rpc, never, Transport> =>
  Layer.effect(
    Rpc,
    Effect.gen(function* () {
      const transport = yield* Transport;
      const provider: GlobalContextProvider = transport
        .callKw({ model: "res.users", method: "context_get", args: [], kwargs: {} })
        .pipe(Effect.flatMap(decodeContext));
      return yield* buildRpc(transport, config, provider);
    }),
  );

/** The {@link Rpc} layer with no layer-level context overrides. */
export const layer: Layer.Layer<Rpc, never, Transport> = layerWith();
