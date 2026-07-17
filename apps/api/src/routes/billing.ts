// Compatibility export. Route implementations live in
// `apps/api/src/modules/billing` (see docs/architecture.md); this keeps the
// server entry point's import list small and stable.
export {
    billingRouter,
    billingWebhookHandler,
} from "../modules/billing/billing.routes";
