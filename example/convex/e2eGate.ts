// The e2e harness takes ownerId from its caller, which is only safe on a test deployment.
export function requireE2E() {
  if (process.env.TENKI_E2E !== "1") {
    throw new Error(
      "e2e functions are disabled; set TENKI_E2E=1 on test deployments only",
    );
  }
}
