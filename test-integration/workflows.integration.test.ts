/**
 * LIVE application workflow specs. The harness installs the common Accounting,
 * CRM, Project, Purchase, Sales, and Inventory applications with their demo data;
 * these specs prove that RPC calls can discover that richer state and execute
 * stateful business methods against it.
 */
import { NodeHttpClient } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { JsonRpcTransport, OdooClient, OdooClientLive, type Rpc, RpcLive } from "../src/index.ts";
import { apiKeyConfig, hasStack, majorVersion, marker, TIMEOUT_MS } from "./support.ts";

const appLayer = (): Layer.Layer<OdooClient | Rpc> => {
  const transport = JsonRpcTransport.layer(apiKeyConfig()).pipe(
    Layer.provide(NodeHttpClient.layerUndici),
  );
  const rpc = RpcLive.layerSeeded().pipe(Layer.provide(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc));
};

const many2OneId = (value: unknown): number => {
  if (!Array.isArray(value) || typeof value[0] !== "number") {
    assert.fail(`expected a many2one pair, got ${JSON.stringify(value)}`);
  }
  return value[0] as number;
};

describe.skipIf(!hasStack)("application workflows (live)", () => {
  it.live.skipIf(!hasStack)(
    "discovers demo records from the installed business applications",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const models = [
          "crm.lead",
          "product.product",
          "project.project",
          "purchase.order",
          "sale.order",
          "stock.picking",
        ];

        for (const model of models) {
          const count = yield* client.searchCount(model, []);
          assert.isAbove(count, 0, `${model} should contain demo records`);
        }
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "groups demo quotations by state through read_group",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const count = yield* client.searchCount("sale.order", []);
        const groups = yield* client.readGroup("sale.order", {
          domain: [],
          fields: ["state"],
          groupby: ["state"],
        });
        assert.isAbove(groups.length, 0);
        assert.strictEqual(
          groups.reduce((total, group) => total + Number(group["__count"] ?? 0), 0),
          count,
        );
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "creates a priced quotation line and confirms the order",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const tag = marker();
        let partnerIds: ReadonlyArray<number> = [];
        let productIds: ReadonlyArray<number> = [];
        let orderIds: ReadonlyArray<number> = [];

        const cleanup = Effect.gen(function* () {
          if (orderIds.length > 0) {
            yield* client
              .call("sale.order", "action_cancel", {
                ids: orderIds,
                context: { disable_cancel_warning: true },
              })
              .pipe(Effect.ignore);
            yield* client.unlink("sale.order", orderIds).pipe(Effect.ignore);
          }
          if (partnerIds.length > 0) {
            yield* client.unlink("res.partner", partnerIds).pipe(Effect.ignore);
          }
          if (productIds.length > 0) {
            yield* client.unlink("product.product", productIds).pipe(Effect.ignore);
          }
        });

        yield* Effect.gen(function* () {
          partnerIds = yield* client.create("res.partner", { name: `${tag}-customer` });
          productIds = yield* client.create("product.product", {
            name: `${tag}-service`,
            type: "service",
            sale_ok: true,
            list_price: 12.5,
          });
          const products = yield* client.read("product.product", productIds, ["uom_id"]);
          const uomId = many2OneId(products[0]?.["uom_id"]);
          orderIds = yield* client.create("sale.order", {
            partner_id: partnerIds[0],
            client_order_ref: tag,
          });
          const uomField = majorVersion >= 19 ? "product_uom_id" : "product_uom";
          yield* client.create("sale.order.line", {
            order_id: orderIds[0],
            product_id: productIds[0],
            name: `${tag} consulting`,
            product_uom_qty: 2,
            [uomField]: uomId,
            price_unit: 12.5,
          });

          const quotations = yield* client.read("sale.order", orderIds, ["amount_untaxed"]);
          assert.strictEqual(quotations[0]?.["amount_untaxed"], 25);

          yield* client.call("sale.order", "action_confirm", { ids: orderIds });
          const orders = yield* client.read("sale.order", orderIds, ["state", "order_line"]);
          assert.strictEqual(orders[0]?.["state"], "sale");
          assert.lengthOf(orders[0]?.["order_line"] as ReadonlyArray<number>, 1);
        }).pipe(Effect.ensuring(cleanup));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "creates and confirms a priced request for quotation",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const tag = marker();
        let supplierIds: ReadonlyArray<number> = [];
        let productIds: ReadonlyArray<number> = [];
        let orderIds: ReadonlyArray<number> = [];

        const cleanup = Effect.gen(function* () {
          if (orderIds.length > 0) {
            yield* client
              .call("purchase.order", "button_unlock", { ids: orderIds })
              .pipe(Effect.ignore);
            yield* client
              .call("purchase.order", "button_cancel", { ids: orderIds })
              .pipe(Effect.ignore);
            yield* client.unlink("purchase.order", orderIds).pipe(Effect.ignore);
          }
          if (supplierIds.length > 0) {
            yield* client.unlink("res.partner", supplierIds).pipe(Effect.ignore);
          }
          if (productIds.length > 0) {
            yield* client.unlink("product.product", productIds).pipe(Effect.ignore);
          }
        });

        yield* Effect.gen(function* () {
          supplierIds = yield* client.create("res.partner", {
            name: `${tag}-supplier`,
            supplier_rank: 1,
          });
          productIds = yield* client.create("product.product", {
            name: `${tag}-purchased-service`,
            type: "service",
            purchase_ok: true,
            standard_price: 7,
          });
          const products = yield* client.read("product.product", productIds, ["uom_id"]);
          const uomId = many2OneId(products[0]?.["uom_id"]);
          orderIds = yield* client.create("purchase.order", {
            partner_id: supplierIds[0],
            partner_ref: tag,
          });
          const uomField = majorVersion >= 19 ? "product_uom_id" : "product_uom";
          yield* client.create("purchase.order.line", {
            order_id: orderIds[0],
            product_id: productIds[0],
            name: `${tag} implementation`,
            product_qty: 3,
            [uomField]: uomId,
            price_unit: 7,
            date_planned: "2030-01-01 00:00:00",
          });

          const requests = yield* client.read("purchase.order", orderIds, ["amount_untaxed"]);
          assert.strictEqual(requests[0]?.["amount_untaxed"], 21);

          yield* client.call("purchase.order", "button_confirm", { ids: orderIds });
          const orders = yield* client.read("purchase.order", orderIds, ["state", "order_line"]);
          assert.include(["purchase", "to approve", "done"], orders[0]?.["state"]);
          assert.lengthOf(orders[0]?.["order_line"] as ReadonlyArray<number>, 1);
        }).pipe(Effect.ensuring(cleanup));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "moves a CRM opportunity through won, lost, and recovered states",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const [stageModel, stageId] = yield* client.ref("crm.stage_lead1");
        assert.strictEqual(stageModel, "crm.stage");
        const leadIds = yield* client.create("crm.lead", {
          name: `${marker()} opportunity`,
          type: "opportunity",
          stage_id: stageId,
        });

        yield* Effect.gen(function* () {
          yield* client.call("crm.lead", "action_set_won", { ids: leadIds });
          const won = yield* client.read("crm.lead", leadIds, [
            "active",
            "date_closed",
            "probability",
            "stage_id",
          ]);
          assert.strictEqual(won[0]?.["active"], true);
          assert.notStrictEqual(won[0]?.["date_closed"], false);
          assert.strictEqual(won[0]?.["probability"], 100);
          const wonStageId = many2OneId(won[0]?.["stage_id"]);
          const wonStages = yield* client.read("crm.stage", [wonStageId], ["is_won"]);
          assert.strictEqual(wonStages[0]?.["is_won"], true);

          yield* client.call("crm.lead", "action_set_lost", { ids: leadIds });
          const lost = yield* client.read("crm.lead", leadIds, ["active", "probability"]);
          assert.strictEqual(lost[0]?.["active"], false);
          assert.strictEqual(lost[0]?.["probability"], 0);

          yield* client.call("crm.lead", "action_set_won", { ids: leadIds });
          const recovered = yield* client.read("crm.lead", leadIds, ["active", "probability"]);
          assert.strictEqual(recovered[0]?.["active"], true);
          assert.strictEqual(recovered[0]?.["probability"], 100);
        }).pipe(Effect.ensuring(client.unlink("crm.lead", leadIds).pipe(Effect.ignore)));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "creates a parent task and archives its subtask in a demo project",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const [projectModel, projectId] = yield* client.ref("project.project_project_1");
        assert.strictEqual(projectModel, "project.project");
        const name = marker();
        const parentIds = yield* client.create("project.task", {
          name: `${name}-parent`,
          project_id: projectId,
        });
        let childIds: ReadonlyArray<number> = [];

        const cleanup = Effect.gen(function* () {
          if (childIds.length > 0) {
            yield* client.unlink("project.task", childIds).pipe(Effect.ignore);
          }
          yield* client.unlink("project.task", parentIds).pipe(Effect.ignore);
        });

        yield* Effect.gen(function* () {
          childIds = yield* client.create("project.task", {
            name: `${name}-child`,
            project_id: projectId,
            parent_id: parentIds[0],
          });
          const wrote = yield* client.write("project.task", childIds, {
            description: `${name} updated through RPC`,
            active: false,
          });
          assert.strictEqual(wrote, true);
          const children = yield* client.read("project.task", childIds, [
            "active",
            "description",
            "parent_id",
          ]);
          assert.strictEqual(children[0]?.["active"], false);
          assert.include(String(children[0]?.["description"]), "updated through RPC");
          assert.strictEqual(many2OneId(children[0]?.["parent_id"]), parentIds[0]);

          const parents = yield* client.read("project.task", parentIds, ["child_ids"]);
          assert.include(parents[0]?.["child_ids"] as ReadonlyArray<number>, childIds[0]);

          yield* client.write("project.task", childIds, { active: true });
          const restored = yield* client.read("project.task", childIds, ["active"]);
          assert.strictEqual(restored[0]?.["active"], true);
        }).pipe(Effect.ensuring(cleanup));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );
});
