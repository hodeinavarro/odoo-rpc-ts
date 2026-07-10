/**
 * Typed constructors for Odoo's x2many write commands — the special 3-element
 * triples an {@link https://www.odoo.com/documentation | One2many}/Many2many
 * field expects inside a `create`/`write` `values` payload.
 *
 * Each command is `[code, id, payload]`: the first element is the integer that
 * identifies the command, the second is either the target record id (update,
 * delete, unlink, link) or `0`, and the third is either the `values` to write
 * (create, update), the new `ids` list (set), or `0`. Straight port of Odoo's
 * `Command` namespace (`odoo/fields.py` 16.x, `odoo/orm/commands.py` 19.x — the
 * emitted triples are identical across 16–19).
 *
 * GOTCHA: over RPC only the literal triples travel — never the Python `Command`
 * enum members or constant names. These constructors return exactly those
 * literal triples, so a value built here is wire-ready as-is.
 */

/** Field-name → value map written by the create/update commands. */
export type CommandValues = { readonly [field: string]: unknown };

/** `create(values)` → `[0, 0, values]` — create a comodel record and link it. */
export type CreateCommand = readonly [0, 0, CommandValues];

/** `update(id, values)` → `[1, id, values]` — write `values` on the related record. */
export type UpdateCommand = readonly [1, number, CommandValues];

/** `delete(id)` → `[2, id, 0]` — unlink and delete the related record from the db. */
export type DeleteCommand = readonly [2, number, 0];

/** `unlink(id)` → `[3, id, 0]` — drop the relation, keep (or cascade) the record. */
export type UnlinkCommand = readonly [3, number, 0];

/** `link(id)` → `[4, id, 0]` — add a relation to an existing record. */
export type LinkCommand = readonly [4, number, 0];

/** `clear()` → `[5, 0, 0]` — unlink every related record. */
export type ClearCommand = readonly [5, 0, 0];

/** `set(ids)` → `[6, 0, ids]` — replace all relations with exactly `ids`. */
export type SetCommand = readonly [6, 0, ReadonlyArray<number>];

/** Any single x2many write command triple. */
export type CommandTuple =
  | CreateCommand
  | UpdateCommand
  | DeleteCommand
  | UnlinkCommand
  | LinkCommand
  | ClearCommand
  | SetCommand;

/** A list of x2many commands, as it sits inside a `values` payload. */
export type X2ManyCommands = ReadonlyArray<CommandTuple>;

/**
 * The `Command` namespace — one constructor per x2many command. Grouped as a
 * frozen object of standalone functions (no `enum`/`namespace`, per
 * `erasableSyntaxOnly`); each carries the wire encoding in its return type so
 * the literal command code survives inference.
 */
export const Command = {
  /**
   * Create new comodel records from `values` and link them to `self`.
   *
   * Wire: `[0, 0, values]`.
   */
  create: (values: CommandValues): CreateCommand => [0, 0, values],

  /**
   * Write `values` on the related record `id`.
   *
   * Wire: `[1, id, values]`.
   */
  update: (id: number, values: CommandValues): UpdateCommand => [1, id, values],

  /**
   * Remove the related record `id` from the database and drop its relation.
   *
   * Wire: `[2, id, 0]`.
   */
  delete: (id: number): DeleteCommand => [2, id, 0],

  /**
   * Remove the relation to record `id` without deleting it (One2many may
   * cascade-delete when the inverse is `ondelete='cascade'`).
   *
   * Wire: `[3, id, 0]`.
   */
  unlink: (id: number): UnlinkCommand => [3, id, 0],

  /**
   * Add a relation between `self` and the existing record `id`.
   *
   * Wire: `[4, id, 0]`.
   */
  link: (id: number): LinkCommand => [4, id, 0],

  /**
   * Remove all relations (equivalent to `unlink` on every related record).
   *
   * Wire: `[5, 0, 0]`.
   */
  clear: (): ClearCommand => [5, 0, 0],

  /**
   * Replace the current relations with exactly `ids` (unlink removed, link
   * added).
   *
   * Wire: `[6, 0, ids]`.
   */
  set: (ids: ReadonlyArray<number>): SetCommand => [6, 0, ids],
} as const;
