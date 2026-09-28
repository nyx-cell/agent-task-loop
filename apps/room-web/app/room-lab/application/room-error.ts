import { LocalRequestError } from '../infrastructure/local-guard.server';
import { RoomCatalogInvariantError } from '../domain/room-catalog';
import { RoomCompositionInvariantError } from '../domain/room-composition';
import { RoomInputError } from './room-service.server';

/** One ladder for every Room action, so a new error class is mapped once. */
export function roomActionStatus(error: unknown): number {
  if (error instanceof RoomInputError) return 400;
  if (error instanceof RoomCatalogInvariantError) return 400;
  if (error instanceof RoomCompositionInvariantError) return 400;
  if (error instanceof LocalRequestError) return error.status;
  return 500;
}

export function roomActionMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Room action failed';
}
