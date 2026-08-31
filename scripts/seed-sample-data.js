// scripts/seed-sample-data.js
//
// Populates a few sample cards via inventory-save, purely so there's real
// data to look at when testing the wiring locally. Run this AFTER starting
// `netlify dev` in another terminal (it posts to your local dev server).
//
// Usage: node scripts/seed-sample-data.js

const BASE_URL = process.env.SEED_TARGET || "http://localhost:8888";

const sampleCards = [
  {
    cardName: "Shanks", cardNumber: "OP07-119", category: "Character",
    rarity: "SEC", foilType: "Foil", language: "Japanese",
    quantity: 1, purchasePrice: 172, purchaseCurrency: "JPY",
    conditionType: "Singles",
    rawSources: {
      toretoku: { price: 203, grade: "A", note: "¥22,100", inStock: false },
      yuyutei: { price: 198, note: "¥21,600", inStock: true },
      pricecharting: { ungraded: 210, psa10: null },
    },
  },
  {
    cardName: "Charlotte Katakuri", cardNumber: "OP03-090", category: "Character",
    rarity: "SR", foilType: "Non-Foil", language: "Japanese",
    quantity: 1, purchasePrice: 80, purchaseCurrency: "USD",
    conditionType: "Slabs", subCondition: "PSA10", gradingCompany: "PSA",
    rawSources: { pricecharting: { ungraded: null, psa10: 95 } },
  },
  {
    cardName: "Nami", cardNumber: "OP02-016", category: "Character",
    rarity: "R", foilType: "Non-Foil", language: "Japanese",
    quantity: 0, purchasePrice: null, // Wanted — no price yet
    conditionType: "Singles",
    rawSources: { yuyutei: { price: 15, note: "¥1,630", inStock: true }, pricecharting: { ungraded: 16, psa10: null } },
  },
  {
    cardName: "Kaido", cardNumber: "OP08-100", category: "Character",
    rarity: "SEC", foilType: "Foil", language: "Japanese",
    quantity: 0, purchasePrice: 205, purchaseCurrency: "JPY", // Pending Delivery
    conditionType: "Singles",
    rawSources: { toretoku: { price: 230, grade: "B", note: "¥25,000", inStock: true } },
  },
];

async function seed() {
  const res = await fetch(`${BASE_URL}/.netlify/functions/inventory-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records: sampleCards }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Seed failed:", data);
    process.exit(1);
  }
  console.log(`Seeded ${data.saved.length} cards:`, data.saved);
}

seed();
