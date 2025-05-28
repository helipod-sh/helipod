# @stackbase/auth

Authentication primitives for Stackbase — password hashing with scrypt (per-call random salt, constant-time verification) and secure token generation. These helpers are runtime-agnostic and work on both Node.js and Bun via `node:crypto`.

Data model adapted from convex-auth (Apache-2.0).
