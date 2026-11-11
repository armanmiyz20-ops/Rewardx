
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();

// Demo rewards: এগুলো আসল টাকা বা UPI payout নয়।
const REWARDS = {
  basic: { name: "Basic Demo Reward", points: 100 },
  premium: { name: "Premium Demo Reward", points: 500 }
};

// User-এর নিজের Wallet থেকে Redeem Request
exports.createRedeemRequest = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Please login first.");
  }

  const reward = REWARDS[request.data?.rewardId];
  if (!reward) {
    throw new HttpsError("invalid-argument", "Invalid reward.");
  }

  const walletRef = db.collection("wallets").doc(uid);
  const requestRef = db
    .collection("users").doc(uid)
    .collection("redeemRequests").doc();

  const historyRef = db
    .collection("users").doc(uid)
    .collection("pointHistory").doc();

  await db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);

    if (!walletSnap.exists) {
      throw new HttpsError("failed-precondition", "Wallet not found.");
    }

    const points = walletSnap.data().points;

    if (!Number.isSafeInteger(points) || points < reward.points) {
      throw new HttpsError("failed-precondition", "Not enough points.");
    }

    tx.update(walletRef, {
      points: points - reward.points
    });

    tx.create(requestRef, {
      rewardId: request.data.rewardId,
      rewardName: reward.name,
      points: reward.points,
      status: "Pending",
      createdAt: FieldValue.serverTimestamp()
    });

    tx.create(historyRef, {
      type: "redeem",
      points: -reward.points,
      description: "Redeem request: " + reward.name,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, message: "Request submitted." };
});

// Admin ছাড়া কেউ Points যোগ করতে পারবে না।
exports.adminAddPoints = onCall(async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  const uid = request.data?.uid;
  const amount = request.data?.amount;

  if (
    typeof uid !== "string" ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 5000
  ) {
    throw new HttpsError("invalid-argument", "Invalid user or points.");
  }

  const walletRef = db.collection("wallets").doc(uid);
  const historyRef = db
    .collection("users").doc(uid)
    .collection("pointHistory").doc();

  await db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);

    if (!walletSnap.exists) {
      throw new HttpsError("failed-precondition", "Wallet not found.");
    }

    const points = walletSnap.data().points;

    if (!Number.isSafeInteger(points) || points < 0) {
      throw new HttpsError("failed-precondition", "Invalid wallet balance.");
    }

    tx.update(walletRef, { points: points + amount });

    tx.create(historyRef, {
      type: "credit",
      points: amount,
      description: "Admin points adjustment",
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true };
});

// Admin-এর Approve / Reject
exports.adminReviewRedeem = onCall(async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  const uid = request.data?.uid;
  const requestId = request.data?.requestId;
  const decision = request.data?.decision;

  if (
    typeof uid !== "string" ||
    typeof requestId !== "string" ||
    !["Approved", "Rejected"].includes(decision)
  ) {
    throw new HttpsError("invalid-argument", "Invalid review details.");
  }

  const requestRef = db
    .collection("users").doc(uid)
    .collection("redeemRequests").doc(requestId);

  const walletRef = db.collection("wallets").doc(uid);

  const historyRef = db
    .collection("users").doc(uid)
    .collection("pointHistory").doc();

  await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);

    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "Request not found.");
    }

    const data = requestSnap.data();

    if (data.status !== "Pending") {
      throw new HttpsError("failed-precondition", "Already reviewed.");
    }

    if (
      !Number.isSafeInteger(data.points) ||
      data.points < 1
    ) {
      throw new HttpsError("failed-precondition", "Invalid request points.");
    }

    if (decision === "Rejected") {
      const walletSnap = await tx.get(walletRef);

      if (!walletSnap.exists) {
        throw new HttpsError("failed-precondition", "Wallet not found.");
      }

      const points = walletSnap.data().points;

      if (!Number.isSafeInteger(points) || points < 0) {
        throw new HttpsError("failed-precondition", "Invalid wallet balance.");
      }

      tx.update(walletRef, {
        points: points + data.points
      });

      tx.create(historyRef, {
        type: "refund",
        points: data.points,
        description: "Redeem request rejected - points refunded",
        createdAt: FieldValue.serverTimestamp()
      });
    }

    tx.update(requestRef, {
      status: decision,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: request.auth.uid
    });
  });

  return { success: true, status: decision };
});
