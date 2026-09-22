import { test,expect } from '@playwright/test';
test('production administration, mapped audits, branding and safe restore',async({page,request})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Create administrator'})).toBeVisible();
  await page.getByLabel('Username').fill('fixture-admin');await page.getByLabel('Password',{exact:true}).fill('fixture-password-123');
  await page.getByRole('button',{name:'Create administrator'}).click();await expect(page.getByRole('heading',{name:/Set up/})).toBeVisible();
  for(let i=0;i<7;i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Finish setup'}).click();await expect(page.getByRole('heading',{name:'H&H Media Guard'})).toBeVisible();
  await page.goto('/settings');
  for(const source of ['Sonarr','Radarr']){
    const card=page.locator('section').filter({has:page.getByRole('heading',{name:source,exact:true})});
    await card.getByLabel('Enabled',{exact:true}).check();await card.getByLabel('Server URL').fill('http://arr-fixture:8989');await card.getByLabel('API key').fill('fixture-api-key');
    await card.getByRole('button',{name:`Save ${source.toLowerCase()}`}).click();await expect(card.getByLabel('API key')).toHaveValue('');
    await card.getByRole('button',{name:'Test connection'}).click();await expect(card.getByText('Detected version: fixture-1.0')).toBeVisible();
  }
  const mappings=page.locator('section').filter({has:page.getByRole('heading',{name:'Path mappings',exact:true})});
  for(const [source,arr,container] of [['sonarr','/arr/tv','/tv'],['radarr','/arr/movies','/movies']]){
    await mappings.getByRole('combobox',{name:'Source',exact:true}).selectOption(source);await mappings.getByLabel('Arr-visible path').fill(arr);await mappings.getByLabel('Container-visible path').fill(container);
    await mappings.getByRole('button',{name:'Test mapping'}).click();await expect(mappings.getByRole('status')).toContainText('resolves safely');
    await mappings.getByRole('button',{name:'Add mapping'}).click();await expect(mappings.getByRole('status')).toHaveText('Mapping saved');
  }
  await page.getByLabel('Application name',{exact:true}).fill('Fixture Media Inspector');await page.getByLabel('Short name',{exact:true}).fill('Inspector');await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('light');
  await page.getByRole('button',{name:'Save appearance'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  const png=await page.screenshot({clip:{x:0,y:0,width:16,height:16}});
  await page.getByLabel('Compact / header logo').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
  await expect(page.locator('.logo img')).toBeVisible();
  await page.goto('/library');await page.getByRole('button',{name:'Start library audit'}).click();await expect(page.getByRole('status')).toContainText('Queued job');
  await page.goto('/jobs');await expect(page.getByText('completed',{exact:true})).toBeVisible();
  await page.goto('/movies');await expect(page.getByText('Generated English Movie',{exact:false})).toBeVisible();await expect(page.getByText('pass',{exact:true})).toBeVisible();await expect(page.getByText('fail',{exact:true})).toBeVisible();
  await page.goto('/tv');await expect(page.getByText(/Generated Pilot/)).toBeVisible();
  await page.goto('/attention');await expect(page.getByRole('heading',{name:/unknown language/})).toBeVisible();
  await page.goto('/history');await expect(page.getByText('/movies/english.mka',{exact:false}).first()).toBeVisible();
  const arrCalls=await (await request.get('http://arr-fixture:8989/__requests')).json();expect(arrCalls.every((call:{method:string})=>call.method==='GET')).toBe(true);
  await page.goto('/settings');await page.getByLabel('Operating mode').selectOption('quarantine');await page.getByLabel('Quarantine directory').fill('/fixtures/quarantine');await page.getByRole('button',{name:'Save language and safety policy'}).click();
  await page.goto('/library');await page.getByLabel('Container-visible media path').fill('/movies/spanish.mka');await page.getByRole('button',{name:'Queue file scan'}).click();
  await expect.poll(async()=>{await page.goto('/quarantine');return page.getByRole('button',{name:'Restore file'}).count();}).toBe(1);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Restore file'}).click();await expect(page.getByText('File restored',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Menu',exact:true}).click();await expect(page.getByRole('navigation',{name:'Primary'})).toBeVisible();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  await page.getByLabel('Username').fill('fixture-admin');await page.getByLabel('Password',{exact:true}).fill('fixture-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Fixture Media Inspector'})).toBeVisible();
});
