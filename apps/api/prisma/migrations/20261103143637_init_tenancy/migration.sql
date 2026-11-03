-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "legalName" VARCHAR(200) NOT NULL,
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(80),
    "state" VARCHAR(80),
    "postalCode" VARCHAR(16),
    "phone" VARCHAR(20),
    "gstin" VARCHAR(15),
    "fssaiLicence" VARCHAR(32),
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "invoiceFooter" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outlets_tenantId_idx" ON "outlets"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "outlets_tenantId_name_key" ON "outlets"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
