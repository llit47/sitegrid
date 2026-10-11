// Drive the same accessible navigation on desktop and mobile.
export async function navigateWorkspace(page, name) {
  const nav = page.getByRole('navigation', { name: 'Nawigacja główna' });
  if (!await nav.isVisible()) await page.getByRole('button', { name: 'Otwórz nawigację', exact: true }).click();
  await nav.getByRole('button', { name, exact: true }).click();
  await page.locator('#workspace-content > .workspace-page-heading h1').getByText(name, { exact: true }).waitFor();
}
export async function selectCompany(page, id, section = 'Projekty') {
  const select = page.locator('#active-organization');
  await select.waitFor({ state: 'attached' });
  if (!await select.isVisible()) await page.getByRole('button', { name: 'Otwórz nawigację', exact: true }).click();
  await select.selectOption(id);
  await navigateWorkspace(page, section);
}
export function acceptDiscardDialogs(page) {
  page.on('dialog', dialog => {
    if (dialog.type() !== 'confirm') throw new Error(`Unexpected ${dialog.type()}: ${dialog.message()}`);
    return dialog.accept();
  });
}
