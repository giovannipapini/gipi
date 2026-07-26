---
name: clean-code
description: Use when writing, reviewing, or refactoring code and need a reference for clean code principles — naming, functions, SOLID, code smells, simple design rules. Covers Uncle Bob, Martin Fowler, Kent Beck, Sandi Metz.
---

# Clean Code Principles

## Overview

Clean code is code that humans can easily read, understand, and modify. It empties the cost of change over time.

> "Any fool can write code that a computer can understand. Good programmers write code that humans can understand." — Martin Fowler

> "The only way to go fast is to go well." — Robert C. Martin

---

## Meaningful Names

| Rule | Bad | Good |
|------|-----|------|
| Reveal intent | `int d;` | `int elapsedTimeInDays;` |
| Avoid disinformation | `accountList` (it's a Map) | `accounts` |
| Make distinctions meaningful | `data1`, `data2` | `sourceRecord`, `destRecord` |
| Use pronounceable names | `genymdhms` | `generationTimestamp` |
| Use searchable names | `86400` | `SECONDS_PER_DAY` |
| No encodings/prefixes | `strName`, `m_name` | `name` |
| Classes = nouns | `Processor`, `Manager` | `Account`, `PaymentGateway` |
| Functions = verbs | `process()` | `calculateInvoiceTotal()` |
| One word per concept | `fetch` vs `get` vs `retrieve` | pick one, use it everywhere |
| Problem domain first | generic names | domain language (`amortization`, `ledger`) |

**Rule of thumb:** if the name needs a comment to explain it, the name is wrong.

---

## Functions

**Single Responsibility** — do one thing, do it well, do it only.

- Small: aim for < 20 lines; blocks inside `if`/`while` should be one line (a function call)
- One level of abstraction per function — don't mix string manipulation with business rules
- **Command-Query Separation (CQS):** a function either _does_ something OR _answers_ something, never both
- Max ~3 arguments; if more are related, group into a parameter object
- No boolean flag arguments — split into two functions
- No output arguments (passing a ref to mutate externally)
- No side effects — function should only do what its name says
- Prefer exceptions over error codes
- **DRY:** Don't Repeat Yourself — every piece of knowledge should have a single, authoritative representation

```python
# BAD: does multiple things, boolean arg, side effect hidden
def process_and_save(user, send_email=True):
    user.name = user.name.strip()
    db.save(user)
    if send_email:
        email.send(user.email, "Welcome")

# GOOD: separate concerns
def normalize_user(user): user.name = user.name.strip()
def save_user(user): db.save(user)
def send_welcome_email(user): email.send(user.email, "Welcome")
```

---

## Comments

**Last resort** — prefer self-documenting code.

| Keep | Remove |
|------|--------|
| Legal/license headers | Commented-out code |
| Explanation of **why** (non-obvious constraint, workaround) | Redundant description of what the code does |
| Warning of consequences | Journal/change-log comments |
| TODO (tracked) | Noise comments (`// Constructor`) |

> "Every comment is a failure to express intent in code." — Robert C. Martin

---

## SOLID Principles

| Letter | Principle | Core idea |
|--------|-----------|-----------|
| **S** | Single Responsibility | One reason to change per module |
| **O** | Open/Closed | Open for extension, closed for modification |
| **L** | Liskov Substitution | Subtypes must be substitutable for their base type |
| **I** | Interface Segregation | Prefer small focused interfaces over fat ones |
| **D** | Dependency Inversion | Depend on abstractions, not concretions |

**DIP in practice:** high-level modules own the interface; low-level modules implement it. This decouples business logic from infrastructure (DB, HTTP, etc.).

---

## Kent Beck's 4 Rules of Simple Design (priority order)

1. **Passes all tests** — nothing matters if the software doesn't work
2. **Reveals intention** — code communicates clearly to the next reader
3. **No duplication (DRY/SPOT)** — every piece of knowledge stated _once and only once_
4. **Fewest elements** — no unnecessary classes, methods, or abstractions

> Rules 2 and 3 feed off each other. Removing duplication often reveals better abstractions; better names often expose hidden duplication.

> "Duplication is far cheaper than the wrong abstraction." — Sandi Metz (prefer tolerating duplication over a premature, incorrect abstraction; apply rule of three before abstracting)

---

## Code Smells (Martin Fowler / Kent Beck)

### Bloaters — things that grew too large
| Smell | Signal | Fix |
|-------|--------|-----|
| Long Method | > 10–20 lines | Extract Function |
| Large Class | too many fields/methods | Extract Class |
| Long Parameter List | > 3–4 args | Introduce Parameter Object, Preserve Whole Object |
| Primitive Obsession | raw strings for email/money/phone | Replace Primitive with Object |
| Data Clumps | same 3 values always together | Extract Class |

### OO Abusers — misusing OO constructs
| Smell | Signal | Fix |
|-------|--------|-----|
| Switch Statements | repeated `switch` on type | Replace Conditional with Polymorphism |
| Temporary Field | field only set in some cases | Extract Class, Introduce Special Case |
| Refused Bequest | subclass ignores inherited methods | Replace Subclass with Delegate |

### Change Preventers — one change requires many edits
| Smell | Signal | Fix |
|-------|--------|-----|
| Divergent Change | class changes for multiple reasons | Split class (SRP) |
| Shotgun Surgery | one change touches many classes | Move Function/Field |
| Parallel Inheritance Hierarchies | adding subclass requires adding another | collapse or delegate |

### Dispensables — things that add no value
| Smell | Signal | Fix |
|-------|--------|-----|
| Duplicate Code | same logic in multiple places | Extract Function |
| Dead Code | unreachable/unused code | Remove Dead Code |
| Speculative Generality | "we might need this later" abstractions | Inline/remove |
| Lazy Class | class that doesn't justify its existence | Inline Class |
| Comments | comment explaining bad code | rename/refactor, delete comment |

### Couplers — excessive coupling
| Smell | Signal | Fix |
|-------|--------|-----|
| Feature Envy | method more interested in another class | Move Function |
| Inappropriate Intimacy | class reaches into another's internals | Hide Delegate, Move Field |
| Message Chains | `a.b().c().d()` | Hide Delegate |
| Middle Man | class mostly delegates to another | Remove Middle Man |

---

## Key Refactorings (Fowler Catalog)

| Refactoring | When |
|-------------|------|
| Extract Function | code block deserves its own name |
| Inline Function | function body is as clear as its name |
| Extract Class | class has too many responsibilities |
| Move Function/Field | feature is more cohesive elsewhere |
| Replace Conditional with Polymorphism | switch/if on type |
| Replace Nested Conditional with Guard Clauses | deep nesting, exit early instead |
| Replace Magic Literal | naked numbers/strings |
| Introduce Parameter Object | recurring group of args |
| Replace Primitive with Object | domain concept disguised as primitive |
| Separate Query from Modifier | function both returns and changes state |

**Safe refactoring loop:**
1. Establish behavior (tests or golden-master)
2. Make one small, behavior-preserving transformation
3. Run tests — system stays green after each step

---

## General Rules (Uncle Bob synthesis)

- **Boy Scout Rule:** leave the code cleaner than you found it
- **Law of Demeter:** a module should only talk to its direct friends (`a.b` not `a.b().c()`)
- **YAGNI:** You Aren't Gonna Need It — don't build for hypothetical future needs
- **KISS:** Keep It Simple — complexity is the enemy
- **Fail Fast:** make errors visible as early as possible; don't return null, throw

---

## Common Mistakes

| Mistake | Correction |
|---------|-----------|
| Naming variables `data`, `manager`, `util` | Use domain-specific, intention-revealing names |
| Mega-function with 200 lines | Extract until every function does one thing |
| Comments explaining what code does | Rewrite code so it explains itself |
| Abstracting after seeing 2 duplicates | Wait for the third instance (rule of three) |
| Using inheritance for code reuse | Prefer composition; use inheritance for subtyping |
| God class / God function | Apply SRP; split into focused units |
| Returning null | Return empty collection, Optional, or Null Object |
| Boolean trap: `render(true, false, true)` | Use named constants or named parameters |
