ALTER TABLE "Purchase" ADD COLUMN "requestId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "requestId" TEXT;

CREATE UNIQUE INDEX "Purchase_requestId_key" ON "Purchase"("requestId");
CREATE UNIQUE INDEX "Expense_requestId_key" ON "Expense"("requestId");
CREATE INDEX "PaymentAttempt_orderId_createdAt_idx" ON "PaymentAttempt"("orderId", "createdAt");
CREATE INDEX "RequestLimit_expiresAt_idx" ON "RequestLimit"("expiresAt");
