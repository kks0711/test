import sys; sys.path.insert(0,'.')
from deck3_jung import *
d=Deck('REBUILDER_통일교육_중학생','중학생',PARTS,FS,PAL)
print(build(d,S,'../decks')); print('\n'.join(w for w in WARN))
