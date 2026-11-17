<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { User } from "@skolia/shared/api";
  import { signIn, signOut } from "../lib/api.ts";
  import { forgetUser } from "../lib/queries.ts";
  import Button from "./Button.svelte";

  let {
    page,
    user,
    onerror,
  }: {
    page: "explore" | "list" | "upload" | "review" | "cards" | "settings" | "about" | "reader";
    user: User | null | undefined;
    onerror: (message: string) => void;
  } = $props();

  /** The account menu: a popover, so the browser closes it on Escape or a click outside
   * and gives focus back to its button. */
  let menu = $state<HTMLElement | null>(null);
  /** On a narrow screen, the links: a drawer from the left. */
  let drawer = $state<HTMLElement | null>(null);
  let header = $state<HTMLElement | null>(null);
  const client = useQueryClient();

  /** Scrolled down past the header and not back up since: on a narrow screen it slides away. */
  let tucked = $state(false);
  let lastY = 0;

  function onscroll(): void {
    const y = window.scrollY;
    const moved = y - lastY;
    if (Math.abs(moved) < 8) return;
    lastY = y;
    const open = !!menu?.matches(":popover-open") || !!drawer?.matches(":popover-open");
    tucked = !open && moved > 0 && y > (header?.offsetHeight ?? 0);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (e: unknown) {
      onerror(e instanceof Error ? e.message : String(e));
    }
  }

  /** The drawer's icons, drawn in 16 by 16 with strokes: a compass, an open book, an arrow up out of a tray, a stack of cards, an i in a circle. */
  const ICONS = {
    explore: "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13ZM10.5 5.5 9 9 5.5 10.5 7 7Z",
    list: "M2 3h4a2 2 0 0 1 2 2v8a1.5 1.5 0 0 0-1.5-1.5H2ZM14 3h-4a2 2 0 0 0-2 2v8a1.5 1.5 0 0 1 1.5-1.5H14Z",
    upload: "M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3",
    review: "M3 5h8v8.5H3ZM5.5 2.5H13V11",
    about: "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13ZM8 7.5V11M8 5h.01",
  } as const;

  function initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || "?";
  }
</script>

<svelte:window {onscroll} />

<header class:tucked bind:this={header}>
  <button type="button" class="menu-button" popovertarget="nav-drawer" aria-label="Menu">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" /></svg>
  </button>
  <a class="brand" href="#/">skolia</a>
  {#snippet link(href: string, label: string, current: boolean, icon: string, drawerOnly: boolean)}
    <a class={{ "drawer-only": drawerOnly }} {href} aria-current={current ? "page" : undefined} onclick={() => drawer?.hidePopover()}>
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d={icon} /></svg>
      {label}
    </a>
  {/snippet}
  <nav id="nav-drawer" popover bind:this={drawer}>
    {@render link("#/", "Explore", page === "explore", ICONS.explore, false)}
    {#if user}
      {@render link("#/list", "Reading list", page === "list", ICONS.list, false)}
      {@render link("#/upload", "Upload", page === "upload", ICONS.upload, false)}
      {@render link("#/review", "Review", page === "review", ICONS.review, false)}
    {/if}
    {@render link("#/about", "About", page === "about", ICONS.about, true)}
  </nav>
  <div class="account">
    {#if user}
      <button type="button" class="avatar-button" popovertarget="account-menu" aria-label="Account: {user.name}">
        {#if user.image}
          <img class="avatar" src={user.image} alt="" referrerpolicy="no-referrer">
        {:else}
          <span class="avatar initial" aria-hidden="true">{initial(user.name)}</span>
        {/if}
      </button>
      <div id="account-menu" class="account-menu" popover bind:this={menu}>
        <p class="who">
          <span class="muted">Signed in as</span>
          <strong>{user.name}</strong>
          <span class="muted email">{user.email}</span>
        </p>
        <ul>
          <li>
            <a href="#/cards" aria-current={page === "cards" ? "page" : undefined} onclick={() => menu?.hidePopover()}>Manage cards</a>
          </li>
          <li>
            <a href="#/settings" aria-current={page === "settings" ? "page" : undefined} onclick={() => menu?.hidePopover()}>Settings</a>
          </li>
          <li>
            <a href="#/about" aria-current={page === "about" ? "page" : undefined} onclick={() => menu?.hidePopover()}>About</a>
          </li>
          <li>
            <button
              type="button"
              onclick={() =>
                run(async () => {
                  menu?.hidePopover();
                  await signOut();
                  if (page === "list" || page === "upload" || page === "review" || page === "cards" || page === "settings")
                    location.hash = "#/";
                  await forgetUser(client);
                })}
              >Sign out</button
            >
          </li>
        </ul>
      </div>
    {:else if user === null}
      <Button variant="primary" onclick={() => run(signIn)}>Sign in</Button>
    {/if}
  </div>
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 1rem;
    height: var(--nav-height);
    padding: 0 var(--gutter);
    background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line);
    transition: translate 0.2s ease;
  }

  .menu-button {
    display: none;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    margin-left: -0.5rem;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }

  .menu-button:hover,
  .menu-button:focus-visible {
    background: var(--current);
    outline: none;
  }

  .menu-button svg {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .brand {
    font-family: var(--reading);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
  }

  /* A popover only on a narrow screen: on a wide one, the browser's popover styles are undone
     and the links sit in the bar */
  nav {
    display: flex;
    position: static;
    inset: auto;
    gap: 0.25rem;
    width: auto;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    overflow: visible;
  }

  nav a {
    display: flex;
    align-items: center;
    padding: 0 0.6rem;
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
  }

  nav a:hover {
    color: var(--text);
  }

  nav a[aria-current="page"] {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .drawer-only,
  .icon {
    display: none;
  }

  @media (max-width: 639px) {
    header {
      gap: 0.5rem;
    }

    header.tucked {
      translate: 0 -100%;
    }

    .menu-button {
      display: grid;
    }

    nav {
      position: fixed;
      inset: 0 auto 0 0;
      flex-direction: column;
      gap: 0;
      width: min(18rem, 80vw);
      height: 100dvh;
      padding: 0.75rem 0;
      background: var(--surface);
      border-right: 1px solid var(--line);
      box-shadow: 6px 0 24px rgb(0 0 0 / 0.15);
      overflow-y: auto;
      translate: 0 0;
      transition:
        translate 0.2s ease,
        display 0.2s allow-discrete,
        overlay 0.2s allow-discrete;
    }

    nav:not(:popover-open) {
      display: none;
      translate: -100% 0;
    }

    @starting-style {
      nav:popover-open {
        translate: -100% 0;
      }
    }

    nav::backdrop {
      background: rgb(0 0 0 / 0.3);
    }

    nav a {
      padding: 0.75rem 1.25rem;
      border-bottom: 0;
      border-left: 3px solid transparent;
    }

    nav a[aria-current="page"] {
      border-left-color: var(--accent);
      background: var(--current);
    }

    nav .drawer-only {
      display: flex;
      margin-top: auto;
    }

    nav a {
      gap: 0.85rem;
    }

    .icon {
      display: block;
      flex: none;
      width: 1.15rem;
      height: 1.15rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.4;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    header,
    nav {
      transition: none;
    }
  }

  .account {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .avatar {
    display: block;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
  }

  .initial {
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--bg);
    font-weight: 600;
  }

  .avatar-button {
    padding: 0;
    border: 2px solid transparent;
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }

  .avatar-button:hover,
  .avatar-button:focus-visible {
    border-color: var(--accent);
  }

  /* The popover sits in the top layer, under the nav's right edge */
  .account-menu {
    position: fixed;
    inset: calc(var(--nav-height) + 0.25rem) var(--gutter) auto auto;
    margin: 0;
    min-width: 14rem;
    max-width: calc(100vw - 2 * var(--gutter));
    padding: 0.25rem 0;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.15);
  }

  .who {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0.5rem 1rem 0.6rem;
    border-bottom: 1px solid var(--line);
    overflow-wrap: anywhere;
  }

  .muted {
    color: var(--muted);
  }

  .email {
    font-size: 0.85rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
  }

  .account-menu a,
  .account-menu button {
    display: block;
    width: 100%;
    padding: 0.5rem 1rem;
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  .account-menu a:hover,
  .account-menu a:focus-visible,
  .account-menu button:hover,
  .account-menu button:focus-visible {
    background: var(--current);
    outline: none;
  }
</style>
