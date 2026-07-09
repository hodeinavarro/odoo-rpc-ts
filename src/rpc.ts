import { Context, Effect, Layer, Option } from "effect";
import { type CallKwParams, Transport, type TransportCallError } from "./transport.ts";

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
 * Build the {@link Rpc} layer over a {@link Transport}, optionally baking in
 * layer-level `globalContext` overrides that sit above the session/base context
 * but below any per-call context.
 */
export const layerWith = (config?: {
  readonly globalContext?: OdooContext;
}): Layer.Layer<Rpc, never, Transport> =>
  Layer.effect(
    Rpc,
    Effect.gen(function* () {
      const transport = yield* Transport;
      const base = Option.getOrElse(
        yield* Effect.serviceOption(GlobalContext),
        (): OdooContext => ({}),
      );
      const layerOverrides = config?.globalContext ?? {};

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
      };

      return { callKw };
    }),
  );

/** The {@link Rpc} layer with no layer-level context overrides. */
export const layer: Layer.Layer<Rpc, never, Transport> = layerWith();
