// Simple in-memory cart per user. Since this bot has one process on Render,
// this is fine — carts reset if the bot restarts, but orders are safely in the DB.

export type CartItem = { id: string; name: string; price: number; quantity: number };

export type OrderDraft = {
  orderType?: "delivery" | "pickup";
  deliveryAddress?: string;
  customerName?: string;
  customerPhone?: string;
  awaitingScreenshotFor?: number; // order id once created
};

const carts = new Map<number, CartItem[]>();
const drafts = new Map<number, OrderDraft>();

export function getCart(userId: number): CartItem[] {
  return carts.get(userId) ?? [];
}

export function addToCart(userId: number, item: { id: string; name: string; price: number }) {
  const cart = carts.get(userId) ?? [];
  const existing = cart.find((c) => c.id === item.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ ...item, quantity: 1 });
  }
  carts.set(userId, cart);
}

export function removeFromCart(userId: number, itemId: string) {
  const cart = carts.get(userId) ?? [];
  const existing = cart.find((c) => c.id === itemId);
  if (existing) {
    existing.quantity -= 1;
    if (existing.quantity <= 0) {
      carts.set(
        userId,
        cart.filter((c) => c.id !== itemId)
      );
    }
  }
}

export function clearCart(userId: number) {
  carts.delete(userId);
}

export function cartTotal(userId: number): number {
  return getCart(userId).reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function getDraft(userId: number): OrderDraft {
  return drafts.get(userId) ?? {};
}

export function setDraft(userId: number, draft: OrderDraft) {
  drafts.set(userId, draft);
}

export function clearDraft(userId: number) {
  drafts.delete(userId);
}
