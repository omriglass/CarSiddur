import { useParams } from "react-router-dom";

import { CarsScreen } from "@/features/admin/cars/components/CarsScreen";

export function CarDetailPage() {
  const { id } = useParams();
  return <CarsScreen initialCarId={id} />;
}
