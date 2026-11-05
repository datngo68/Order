CREATE TABLE "DiningTable" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "area" TEXT NOT NULL DEFAULT '',
  "seats" INTEGER NOT NULL DEFAULT 4,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "qrToken" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiningTable_name_key" ON "DiningTable"("name");
CREATE UNIQUE INDEX "DiningTable_qrToken_key" ON "DiningTable"("qrToken");
CREATE TABLE "TableVisit" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "activeTableId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "billRequestedAt" TIMESTAMP(3),
  "billAcknowledgedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "TableVisit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TableVisit_activeTableId_check" CHECK (("closedAt" IS NULL AND "activeTableId" = "tableId" AND "activeTableId" IS NOT NULL) OR ("closedAt" IS NOT NULL AND "activeTableId" IS NULL))
);
CREATE UNIQUE INDEX "TableVisit_token_key" ON "TableVisit"("token");
CREATE UNIQUE INDEX "TableVisit_activeTableId_key" ON "TableVisit"("activeTableId");
CREATE INDEX "TableVisit_tableId_openedAt_idx" ON "TableVisit"("tableId", "openedAt");
CREATE INDEX "TableVisit_closedAt_billRequestedAt_idx" ON "TableVisit"("closedAt", "billRequestedAt");
ALTER TABLE "TableVisit" ADD CONSTRAINT "TableVisit_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD COLUMN "tableVisitId" TEXT;
CREATE INDEX "Order_tableVisitId_idx" ON "Order"("tableVisitId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableVisitId_fkey" FOREIGN KEY ("tableVisitId") REFERENCES "TableVisit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
