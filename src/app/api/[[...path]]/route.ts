import { handleNextApi } from "@/server/api/next";

export const dynamic = "force-dynamic";
export {
  handleNextApi as GET,
  handleNextApi as HEAD,
  handleNextApi as POST,
  handleNextApi as PUT,
  handleNextApi as PATCH,
  handleNextApi as DELETE,
  handleNextApi as OPTIONS,
};
