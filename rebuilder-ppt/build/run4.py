import sys; sys.path.insert(0,'.')
from deck4_go import *
d=Deck('REBUILDER_통일교육_고등학생','고등학생',PARTS,FS,PAL)
print(build(d,S,'../decks')); print('\n'.join(w for w in WARN))
