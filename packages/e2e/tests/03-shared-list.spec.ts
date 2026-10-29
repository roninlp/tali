import { expect, pullAll, test, uniqueTag } from "./support"

/**
 * Gate flow 3 (#81/#84): an item checked on device A appears live on device B.
 *
 * The live update is the cursor-wake pull (`sync-runner.tsx`, 10 s while active),
 * not a reload: B stays on `/lists/:id` for the whole assertion, and the row's
 * `data-done` flip plus the "توسط همخانه به‌روزرسانی شد" attribution prove the
 * change arrived from the household feed rather than from B's own tap.
 */
test("flow 3: a shared list updates live across devices", async ({
  alicePage,
  bobPage,
  aliceApi
}, testInfo) => {
  const tag = uniqueTag()
  const listTitle = `خرید هفتگی ${tag}`
  const itemName = `شیر ${tag}`

  // ── A creates a shared list and one item ───────────────────────────────
  await alicePage.goto("/lists")
  await alicePage.getByLabel("عنوان", { exact: true }).fill(listTitle)
  await alicePage.getByRole("button", { name: "ساختن فهرست" }).click()

  await expect(alicePage).toHaveURL(/\/lists\/[0-9a-z-]+$/)
  const listId = new URL(alicePage.url()).pathname.split("/").pop()!
  // The default is household-shared; assert it instead of trusting the form.
  await expect(alicePage.getByLabel("دسترسی")).toHaveValue("shared")

  await alicePage.getByLabel("نام مورد تازه").fill(itemName)
  await alicePage.getByRole("button", { name: "افزودن", exact: true }).click()
  await expect(alicePage.getByRole("checkbox", { name: `تیک زدن ${itemName}` })).toBeVisible()

  // ── B opens the same list from the index (pulled, not deep-linked) ─────
  await bobPage.goto("/lists")
  const card = bobPage.locator("article.lists-index-card").filter({ hasText: listTitle })
  await expect(card).toBeVisible()
  await card.getByRole("link").click()

  await expect(bobPage).toHaveURL(new RegExp(`/lists/${listId}$`))
  await expect(bobPage.locator(`li.lists-item`, { hasText: itemName })).toBeVisible()

  // ── A checks it; B updates without a reload ────────────────────────────
  await alicePage.getByRole("checkbox", { name: `تیک زدن ${itemName}` }).click()
  await expect(alicePage.getByText(`تیک خورد: ${itemName}`)).toBeVisible()

  const bobRow = bobPage.locator("li.lists-item", { hasText: itemName })
  await expect(bobPage.getByRole("checkbox", { name: `برداشتن تیک ${itemName}` })).toBeVisible()
  await expect(bobRow).toHaveAttribute("data-done", "true")
  await expect(bobRow).toContainText("توسط همخانه به‌روزرسانی شد")

  // The feed agrees: one item row, checked, written by the other member.
  const rows = await pullAll(aliceApi)
  const item = rows.find(
    (row) => row.entityType === "listItem" && row.data.name === itemName
  )
  expect(item, "the item is on the household feed").toBeDefined()

  await testInfo.attach("list.json", {
    body: JSON.stringify({ listTitle, listId, itemName, itemId: item?.entityId }, null, 2),
    contentType: "application/json"
  })
})
