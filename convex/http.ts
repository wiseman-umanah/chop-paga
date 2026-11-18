import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { pagaCheckoutCallback, pagaTransferCallback } from "./http_actions";
import { PAGA_CHECKOUT_CALLBACK_PATH, PAGA_TRANSFER_CALLBACK_PATH } from "./paga";

const http = httpRouter();

// Convex Auth requires these routes
auth.addHttpRoutes(http);

// Paga Checkout payment notification (collections)
http.route({
  path: PAGA_CHECKOUT_CALLBACK_PATH,
  method: "POST",
  handler: pagaCheckoutCallback,
});

// Paga money-transfer notification (payouts)
http.route({
  path: PAGA_TRANSFER_CALLBACK_PATH,
  method: "POST",
  handler: pagaTransferCallback,
});

export default http;
