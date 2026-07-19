# The privacy commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PRIVACY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PRIVACY-COMMITMENT.md).

The privacy commitment is **product-wide**. It covers every product Skyphusion Labs ships (the
Vivijure constellation, Postern, Prism, Slate), so it lives at the hub in one copy and every product
repository points at it rather than carrying its own. A commitment that exists in six places is a
commitment that will eventually say six different things.

This file is a pointer so they can never drift. Do not paste the text here.

## What it says, in one line

Privacy, autonomy, and agency are the primary goal, ranked above feature completeness rather than
traded against it; when a feature cannot be built without violating that, **we drop the feature, not
the line**; public source is the audit mechanism that makes the promise checkable; and the CSAM and
NCII bright line is the one stated exception.

## Why the pointer sits here

Postern is the cleanest case in the whole inventory: **we operate nothing and we hold nothing.**
Postern is free software you deploy into your own Cloudflare account on your own domain, and your
mail lives entirely on infrastructure you control. Your instance never talks to us, so there is
nothing for us to collect, disclose, or be compelled to hand over.

[`PRIVACY.md`](PRIVACY.md) is the detailed policy and remains canonical for this product. The
commitment is the standard that policy is written against.

That mail is the most sensitive thing in this whole product line is not incidental to why the
commitment matters here. The strongest privacy guarantee available is not a promise about how we
handle your data; it is an architecture in which we never receive it. Postern is that architecture,
and the commitment is why it stays that way when a hosted version would be easier to sell.

## The tripwire

**If Postern ever grows a component that sends anything from a self-hosted instance back to us, or
if Skyphusion Labs ever operates a Postern instance for other people, the commitment stops being
true, and whoever ships it owns updating the canonical document in the same PR.** See the canonical
copy for the full set of drift tripwires.
