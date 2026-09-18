-- AlterTable
ALTER TABLE "medicos" ADD COLUMN "usuario_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "medicos_usuario_id_key" ON "medicos"("usuario_id");

-- AddForeignKey
ALTER TABLE "medicos" ADD CONSTRAINT "medicos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
