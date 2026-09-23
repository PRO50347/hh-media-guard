"""Fail CI if the public template loses its deployment/security contract."""
from pathlib import Path
import xml.etree.ElementTree as ET
root = ET.parse('unraid/hh-media-guard.xml').getroot()
assert root.findtext('Repository') == 'ghcr.io/pro50347/hh-media-guard:latest'
assert root.findtext('WebUI') == 'http://[IP]:[PORT:3938]'
assert root.findtext('Icon') == 'https://raw.githubusercontent.com/PRO50347/hh-media-guard/main/public/branding/fox-logo.png'
fields = {e.attrib['Target']: e.attrib for e in root.findall('Config')}
assert len(fields) == len(root.findall('Config'))
for target, kind, mode, default in [
    ('3938','Port','tcp','3938'),('/config','Path','rw','/mnt/user/appdata/hh-media-guard'),
    ('/Media','Path','ro',''),('ENCRYPTION_KEY','Variable','',''),
    ('ALLOW_DESTRUCTIVE_ACTIONS','Variable','','false'),('MEDIA_ROOTS','Variable','','/Media'),
    ('TZ','Variable','','Etc/UTC'),('APP_URL','Variable','',''),('ALLOWED_ORIGINS','Variable','',''),
    ('PUID','Variable','','99'),('PGID','Variable','','100')]:
    f=fields[target]
    assert (f['Type'],f['Mode'],f['Default']) == (kind,mode,default), target
    assert f.get('Name') and f.get('Description'), target
assert fields['ENCRYPTION_KEY']['Mask'] == 'true'
assert fields['APP_URL']['Required'] == 'true'
text = Path('unraid/hh-media-guard.xml').read_text()
for private in ['10.0.0.141','/mnt/user/Plex','appdata_plex','America/Detroit']:
    assert private not in text
print('Unraid template contract passed')
